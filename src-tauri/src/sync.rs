//! Publishing local edits to Backlog and bringing in Backlog's changes (design §6.3, §6.6): the
//! I/O around `doc_sync_engine::plan_push` and `doc_sync_engine::merge`.

use std::future::Future;

use backlog_api::{Client, ContentUpdate, Document};
use doc_sync_engine::{Chunk, PushPlan, Snapshot, clean, merge, plan_push};
use serde::Serialize;
use ts_rs::TS;

use crate::error::{CommandError, ErrorKind};
use crate::store::{Store, StoredDocument, VersionReason};

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
    /// Backlog changed meanwhile in other places: its changes were merged into the local edits,
    /// and the merged body was published.
    Merged,
    /// Backlog changed meanwhile in the same places. Nothing was sent and nothing changed: the
    /// user decides each place (see `MergeProposal`), then publishes again.
    NeedsMerge,
    /// Nothing was sent: there were no local edits, or Backlog already had them.
    NothingToSend,
}

/// What "Bring in Backlog's changes" did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PullOutcome {
    /// Backlog has nothing newer.
    UpToDate,
    /// There were no local edits: Backlog's body is now shown.
    Updated,
    /// Backlog's changes were merged into the local edits.
    Merged,
    /// Backlog changed the same places as the local edits. Nothing changed yet.
    NeedsMerge,
}

/// A piece of a merge, for the user to review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum MergeChunk {
    /// Text the merge settled.
    Same { text: String },
    /// A place both sides changed: keep Backlog's lines, the local ones, or both.
    Conflict { local: String, remote: String },
}

/// A merge that needs decisions. Apply the chosen text with `apply_merge`, passing back
/// `remote_plain` and `remote_updated` as the new base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MergeProposal {
    pub chunks: Vec<MergeChunk>,
    pub remote_plain: String,
    /// ISO 8601
    pub remote_updated: String,
}

impl MergeProposal {
    fn new(chunks: Vec<Chunk>, remote: &Document) -> Self {
        Self {
            chunks: chunks
                .into_iter()
                .map(|c| match c {
                    Chunk::Same(text) => MergeChunk::Same { text },
                    Chunk::Conflict { local, remote } => MergeChunk::Conflict { local, remote },
                })
                .collect(),
            remote_plain: remote.plain.clone().unwrap_or_default(),
            remote_updated: remote.updated.clone(),
        }
    }
}

/// Publishes the local edits of a stored document. Fetching and sending happen back to back to
/// keep the window for a lost update short (design §6.4). When Backlog changed meanwhile, its
/// changes are merged in first; if they overlap the local edits, nothing is sent and the
/// returned proposal lists the places to decide. The local edits are never dropped: they stay,
/// are published, or are kept as a version before a merged body replaces them.
pub async fn publish(
    api: &impl DocumentApi,
    store: &Store,
    id: &str,
) -> Result<(PublishOutcome, Option<MergeProposal>), CommandError> {
    let doc = store.document(id)?.ok_or_else(CommandError::not_stored)?;
    if doc.read_only {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the document is read-only",
        ));
    }
    let Some(local) = doc.local_plain.as_deref() else {
        return Ok((PublishOutcome::NothingToSend, None));
    };
    let base = base_snapshot(&doc);
    for _ in 0..MAX_ATTEMPTS {
        let remote = api.document(id).await?;
        let remote_plain = remote.plain.as_deref().unwrap_or_default();
        let (content, outcome) = match plan_push(base, local, snapshot(&remote)) {
            PushPlan::Send(content) => (content, PublishOutcome::Published),
            PushPlan::Conflict => {
                let chunks = merge(base.plain, local, remote_plain);
                match clean(&chunks) {
                    None => {
                        let proposal = MergeProposal::new(chunks, &remote);
                        return Ok((PublishOutcome::NeedsMerge, Some(proposal)));
                    }
                    Some(merged) if merged == remote_plain => {
                        store.rebase(
                            id,
                            remote_plain,
                            &remote.updated,
                            &merged,
                            VersionReason::BeforeMerge,
                        )?;
                        return Ok((PublishOutcome::NothingToSend, None));
                    }
                    Some(merged) => {
                        store.add_version(id, local, VersionReason::BeforeMerge)?;
                        (merged, PublishOutcome::Merged)
                    }
                }
            }
            PushPlan::NothingToSend => {
                store.settle(&remote, local, false)?;
                return Ok((PublishOutcome::NothingToSend, None));
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
                store.settle(&stored, local, update.markdown_is_fallback)?;
                return Ok((outcome, None));
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

/// "Bring in Backlog's changes": fetches the document and merges Backlog's changes into the
/// local edits. Overlapping changes are returned as a proposal and change nothing.
pub async fn pull(
    api: &impl DocumentApi,
    store: &Store,
    id: &str,
) -> Result<(PullOutcome, Option<MergeProposal>), CommandError> {
    let doc = store.document(id)?.ok_or_else(CommandError::not_stored)?;
    let remote = api.document(id).await?;
    let unchanged = snapshot(&remote) == base_snapshot(&doc);
    // Keeps the base when there are local edits; adopts Backlog's body otherwise.
    store.put_document(&remote)?;
    let Some(local) = doc.local_plain.as_deref() else {
        let outcome = if unchanged {
            PullOutcome::UpToDate
        } else {
            PullOutcome::Updated
        };
        return Ok((outcome, None));
    };
    if unchanged {
        return Ok((PullOutcome::UpToDate, None));
    }
    let remote_plain = remote.plain.as_deref().unwrap_or_default();
    let chunks = merge(base_snapshot(&doc).plain, local, remote_plain);
    match clean(&chunks) {
        Some(merged) => {
            store.rebase(
                id,
                remote_plain,
                &remote.updated,
                &merged,
                VersionReason::BeforeMerge,
            )?;
            Ok((PullOutcome::Merged, None))
        }
        None => Ok((
            PullOutcome::NeedsMerge,
            Some(MergeProposal::new(chunks, &remote)),
        )),
    }
}

fn base_snapshot(doc: &StoredDocument) -> Snapshot<'_> {
    Snapshot {
        plain: doc.base_plain.as_deref().unwrap_or_default(),
        updated: doc.base_updated.as_deref().unwrap_or_default(),
    }
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
    use crate::store::VersionReason;

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
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Published);
        assert_eq!(backlog.sent(), ["a b"]);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.plain.as_deref(), Some("a b\n"));
        assert_eq!(view.updated.as_deref(), Some(T3));
        assert_eq!(view.local_plain, None);
        assert_eq!(view.state, SyncState::Synced);
    }

    const BASE: &str = "one\n\ntwo\n\nthree\n";

    /// A store whose document `d1` has base `BASE` at T1 and `local` as edits.
    fn store_editing(local: &str) -> Store {
        let store = Store::open_in_memory().unwrap();
        store.put_document(&document(BASE, T1)).unwrap();
        store.save_local("d1", local).unwrap();
        store
    }

    #[test]
    fn backlog_changes_elsewhere_are_merged_in_and_published() {
        let store = store_editing("one, mine\n\ntwo\n\nthree\n");
        let backlog = FakeBacklog::new("one\n\ntwo\n\nthree, theirs\n", T2);
        let (outcome, proposal) = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Merged);
        assert_eq!(proposal, None);
        assert_eq!(backlog.sent(), ["one, mine\n\ntwo\n\nthree, theirs\n"]);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.local_plain, None);
        assert_eq!(view.state, SyncState::Synced);
        // The edits as they were before the merge are kept.
        let versions = store.versions("d1").unwrap();
        assert_eq!(versions[0].plain, "one, mine\n\ntwo\n\nthree\n");
        assert_eq!(versions[0].reason, VersionReason::BeforeMerge);
    }

    #[test]
    fn overlapping_changes_send_nothing_and_keep_the_edits() {
        let store = store_editing("one\n\ntwo, mine\n\nthree\n");
        let backlog = FakeBacklog::new("one\n\ntwo, theirs\n\nthree\n", T2);
        let (outcome, proposal) = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::NeedsMerge);
        assert!(backlog.sent().is_empty());
        let proposal = proposal.unwrap();
        assert_eq!(proposal.remote_updated, T2);
        assert!(proposal.chunks.contains(&MergeChunk::Conflict {
            local: "two, mine\n".into(),
            remote: "two, theirs\n".into(),
        }));
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(
            view.local_plain.as_deref(),
            Some("one\n\ntwo, mine\n\nthree\n")
        );
        assert_eq!(view.plain.as_deref(), Some(BASE));
        assert_eq!(view.state, SyncState::Edited);
    }

    #[test]
    fn pull_merges_backlog_changes_into_the_edits() {
        let store = store_editing("one, mine\n\ntwo\n\nthree\n");
        let backlog = FakeBacklog::new("one\n\ntwo\n\nthree, theirs\n", T2);
        let (outcome, _) = block_on(pull(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PullOutcome::Merged);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.plain.as_deref(), Some("one\n\ntwo\n\nthree, theirs\n"));
        assert_eq!(view.updated.as_deref(), Some(T2));
        assert_eq!(
            view.local_plain.as_deref(),
            Some("one, mine\n\ntwo\n\nthree, theirs\n")
        );
        assert_eq!(
            store.versions("d1").unwrap()[0].plain,
            "one, mine\n\ntwo\n\nthree\n"
        );
        // Publishing now sends the merged body without another merge.
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Published);
    }

    #[test]
    fn pull_with_overlaps_changes_nothing() {
        let store = store_editing("one\n\ntwo, mine\n\nthree\n");
        let backlog = FakeBacklog::new("one\n\ntwo, theirs\n\nthree\n", T2);
        let (outcome, proposal) = block_on(pull(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PullOutcome::NeedsMerge);
        assert!(proposal.is_some());
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(
            view.local_plain.as_deref(),
            Some("one\n\ntwo, mine\n\nthree\n")
        );
        assert_eq!(view.plain.as_deref(), Some(BASE));
        assert_eq!(store.version_count("d1").unwrap(), 0);
    }

    #[test]
    fn pull_without_edits_shows_backlogs_body() {
        let store = Store::open_in_memory().unwrap();
        store.put_document(&document(BASE, T1)).unwrap();
        let backlog = FakeBacklog::new("new\n", T2);
        let (outcome, _) = block_on(pull(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PullOutcome::Updated);
        assert_eq!(
            document_view(&store, "d1").unwrap().plain.as_deref(),
            Some("new\n")
        );
        let (outcome, _) = block_on(pull(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PullOutcome::UpToDate);
    }

    #[test]
    fn nothing_to_send_when_backlog_already_has_the_edits() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a b", T2);
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
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
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::NothingToSend);
        assert!(backlog.sent().is_empty());
    }

    #[test]
    fn concurrent_edit_error_retries() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([Reply::Fail(409)]);
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
        assert_eq!(outcome, PublishOutcome::Published);
        assert_eq!(backlog.sent(), ["a b", "a b"]);
    }

    #[test]
    fn retry_starts_over_from_the_fetch() {
        let store = edited_store();
        let backlog = FakeBacklog::new("a", T1).reply([Reply::LoseRace("a c")]);
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
        // Backlog now has "a c", which overlaps the local "a b": nothing more is sent.
        assert_eq!(outcome, PublishOutcome::NeedsMerge);
        assert_eq!(backlog.sent(), ["a b"]);
        let view = document_view(&store, "d1").unwrap();
        assert_eq!(view.local_plain.as_deref(), Some("a b"));
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
        let (outcome, _) = block_on(publish(&backlog, &store, "d1")).unwrap();
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
