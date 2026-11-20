//! Publishing local edits to Backlog (design §6.3): the I/O around `doc_sync_engine::plan_push`.

use std::future::Future;

use backlog_api::{Client, ContentUpdate, Document};
use doc_sync_engine::{PushPlan, Snapshot, plan_push};
use serde::Serialize;
use ts_rs::TS;

use crate::error::{CommandError, ErrorKind};
use crate::store::Store;

/// How many times a publish starts over when Backlog reports a concurrent edit.
const MAX_ATTEMPTS: usize = 3;

/// The Backlog calls that publishing makes. Tests use a fake.
pub trait DocumentApi {
    fn document(
        &self,
        id: &str,
    ) -> impl Future<Output = Result<Document, backlog_api::Error>> + Send;

    fn update_document_content(
        &self,
        id: &str,
        content: &str,
    ) -> impl Future<Output = Result<ContentUpdate, backlog_api::Error>> + Send;
}

impl DocumentApi for Client {
    fn document(
        &self,
        id: &str,
    ) -> impl Future<Output = Result<Document, backlog_api::Error>> + Send {
        Client::document(self, id)
    }

    fn update_document_content(
        &self,
        id: &str,
        content: &str,
    ) -> impl Future<Output = Result<ContentUpdate, backlog_api::Error>> + Send {
        Client::update_document_content(self, id, content)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PublishOutcome {
    /// Backlog has the local edits, and the body it stored is the new base.
    Published,
    /// Backlog changed meanwhile. The local edits became a conflict copy, and Backlog's body is
    /// the new base.
    Conflict,
    /// Nothing was sent: there were no local edits, or Backlog already had them.
    NothingToSend,
}

/// Publishes the local edits of a stored document. Fetching and sending happen back to back to
/// keep the window for a lost update short (design §6.4). Whatever happens, the local edits stay
/// in the store, are published, or become a conflict copy.
pub async fn publish(
    api: &impl DocumentApi,
    store: &Store,
    id: &str,
) -> Result<PublishOutcome, CommandError> {
    let doc = store.document(id)?.ok_or_else(CommandError::not_stored)?;
    if doc.read_only {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the document is read-only",
        ));
    }
    let Some(local) = doc.local_plain else {
        return Ok(PublishOutcome::NothingToSend);
    };
    let base = Snapshot {
        plain: doc.base_plain.as_deref().unwrap_or_default(),
        updated: doc.base_updated.as_deref().unwrap_or_default(),
    };
    for _ in 0..MAX_ATTEMPTS {
        let remote = api.document(id).await?;
        let content = match plan_push(base, &local, snapshot(&remote)) {
            PushPlan::Send(content) => content,
            PushPlan::Conflict => {
                store.record_conflict(&remote, &local)?;
                return Ok(PublishOutcome::Conflict);
            }
            PushPlan::NothingToSend => {
                store.settle(&remote, &local, false)?;
                return Ok(PublishOutcome::NothingToSend);
            }
        };
        match api.update_document_content(id, &content).await {
            Ok(update) => {
                let stored = api.document(id).await.map_err(|e| {
                    CommandError::new(
                        ErrorKind::Api,
                        format!("Published, but reloading the document failed: {e}"),
                    )
                })?;
                store.settle(&stored, &local, update.markdown_is_fallback)?;
                return Ok(PublishOutcome::Published);
            }
            // Backlog has no conditional update. A 409 says the document changed while it was
            // sent, so start over from the fetch.
            Err(e) if e.status() == Some(409) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(CommandError::new(
        ErrorKind::Api,
        "the document kept changing on Backlog while publishing; try again",
    ))
}

fn snapshot(doc: &Document) -> Snapshot<'_> {
    Snapshot {
        plain: doc.plain.as_deref().unwrap_or_default(),
        updated: &doc.updated,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use tauri::async_runtime::block_on;

    use super::*;
    use crate::commands::{SyncState, document_view};

    const T1: &str = "2026-11-20T01:00:00Z";
    const T2: &str = "2026-11-20T01:05:00Z";
    const T3: &str = "2026-11-20T01:10:00Z";

    /// How the fake answers the next content update.
    enum Reply {
        /// Stores the body with a trailing newline, as a stand-in for Backlog's normalization.
        Accept,
        /// Saves the body but leaves `plain` stale, like a `markdownIsFallback` update.
        AcceptWithFallback,
        Fail(u16),
        /// Someone else saved this body first, then the update failed with 409.
        LoseRace(&'static str),
    }

    struct FakeBacklog {
        remote: Mutex<Document>,
        /// Replies to the next content updates; `Accept` once these run out.
        replies: Mutex<VecDeque<Reply>>,
        sent: Mutex<Vec<String>>,
    }

    impl FakeBacklog {
        fn new(plain: &str, updated: &str) -> Self {
            Self {
                remote: Mutex::new(document(plain, updated)),
                replies: Mutex::default(),
                sent: Mutex::default(),
            }
        }

        fn reply(self, replies: impl IntoIterator<Item = Reply>) -> Self {
            self.replies.lock().unwrap().extend(replies);
            self
        }

        fn sent(&self) -> Vec<String> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl DocumentApi for FakeBacklog {
        fn document(
            &self,
            _id: &str,
        ) -> impl Future<Output = Result<Document, backlog_api::Error>> + Send {
            let doc = self.remote.lock().unwrap().clone();
            async move { Ok(doc) }
        }

        fn update_document_content(
            &self,
            _id: &str,
            content: &str,
        ) -> impl Future<Output = Result<ContentUpdate, backlog_api::Error>> + Send {
            self.sent.lock().unwrap().push(content.to_owned());
            let reply = self.replies.lock().unwrap().pop_front();
            let mut remote = self.remote.lock().unwrap();
            let result = match reply.unwrap_or(Reply::Accept) {
                Reply::Accept => {
                    *remote = document(&format!("{content}\n"), T3);
                    Ok(ContentUpdate {
                        markdown_is_fallback: false,
                    })
                }
                Reply::AcceptWithFallback => {
                    remote.updated = T3.into();
                    Ok(ContentUpdate {
                        markdown_is_fallback: true,
                    })
                }
                Reply::Fail(status) => Err(api_error(status)),
                Reply::LoseRace(theirs) => {
                    *remote = document(theirs, T2);
                    Err(api_error(409))
                }
            };
            async move { result }
        }
    }

    fn document(plain: &str, updated: &str) -> Document {
        Document {
            id: "d1".into(),
            project_id: 1,
            title: "title".into(),
            plain: Some(plain.into()),
            created: T1.into(),
            updated: updated.into(),
        }
    }

    fn api_error(status: u16) -> backlog_api::Error {
        backlog_api::Error::Api {
            status,
            errors: Vec::new(),
        }
    }

    /// A store whose document `d1` has base "a" at T1 and the local edits "a b".
    fn edited_store() -> Store {
        let store = Store::open_in_memory().unwrap();
        store.put_document(&document("a", T1)).unwrap();
        store.save_local("d1", "a b").unwrap();
        store
    }

    #[test]
    fn publishes_the_edits_and_adopts_the_stored_body() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Published);
        assert_eq!(backlog.sent(), ["a b"]);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.plain.as_deref(), Some("a b\n"));
        assert_eq!(view.updated.as_deref(), Some(T3));
        assert_eq!(view.local_plain, None);
        assert_eq!(view.state, SyncState::Synced);
    }

    #[test]
    fn remote_change_keeps_the_edits_as_a_conflict_copy() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a c", T2);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Conflict);
        assert!(backlog.sent().is_empty());
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.plain.as_deref(), Some("a c"));
        assert_eq!(view.local_plain, None);
        assert_eq!(view.state, SyncState::Conflict);
        assert_eq!(view.conflicts.len(), 1);
        assert_eq!(view.conflicts[0].local_plain, "a b");
        assert_eq!(view.conflicts[0].remote_plain, "a c");

        // The user reapplies the edits by hand, then marks the copy resolved.
        store.save_local("d1", "a b c").unwrap();
        assert_eq!(
            document_view(&store, "d1").unwrap().state,
            SyncState::Conflict
        );
        store.resolve_conflict("d1", view.conflicts[0].id).unwrap();
        assert_eq!(
            document_view(&store, "d1").unwrap().state,
            SyncState::Edited
        );
    }

    #[test]
    fn nothing_to_send_when_backlog_already_has_the_edits() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a b", T2);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::NothingToSend);
        assert!(backlog.sent().is_empty());
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.updated.as_deref(), Some(T2));
        assert_eq!(view.state, SyncState::Synced);
    }

    #[test]
    fn nothing_to_send_without_edits() {
        let store = Store::open_in_memory().unwrap();
        store.put_document(&document("a", T1)).unwrap();
        let backlog = FakeBacklog::new("a", T1);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::NothingToSend);
        assert!(backlog.sent().is_empty());
    }

    #[test]
    fn concurrent_edit_error_retries() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([Reply::Fail(409)]);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Published);
        assert_eq!(backlog.sent(), ["a b", "a b"]);
    }

    #[test]
    fn retry_starts_over_from_the_fetch() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([Reply::LoseRace("a c")]);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Conflict);
        assert_eq!(backlog.sent(), ["a b"]);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.conflicts[0].remote_plain, "a c");
    }

    #[test]
    fn gives_up_after_three_concurrent_edit_errors_and_keeps_the_edits() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([409, 409, 409, 409].map(Reply::Fail));
        let error = block_on(publish(&backlog, &store, "d1")).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::Api));
        assert_eq!(backlog.sent().len(), MAX_ATTEMPTS);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.local_plain.as_deref(), Some("a b"));
        assert_eq!(view.state, SyncState::Edited);
    }

    #[test]
    fn other_errors_do_not_retry_and_keep_the_edits() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([Reply::Fail(403)]);
        let error = block_on(publish(&backlog, &store, "d1")).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::Api));
        assert_eq!(backlog.sent(), ["a b"]);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.local_plain.as_deref(), Some("a b"));
    }

    #[test]
    fn fallback_update_makes_the_document_read_only() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([Reply::AcceptWithFallback]);
        let outcome = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Published);
        let view = document_view(&store, "d1").unwrap();
        assert!(view.read_only);
        assert_eq!(view.local_plain, None);

        store.save_local("d1", "a d").unwrap();
        let error = block_on(publish(&backlog, &store, "d1")).unwrap_err();
        assert!(matches!(error.kind, ErrorKind::InvalidInput));
        assert_eq!(backlog.sent(), ["a b"]);
    }
}
