//! Local SQLite cache (see docs/design.md §7).

use std::path::Path;
use std::sync::Mutex;

use backlog_api::FileContent;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use ts_rs::TS;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- API responses kept as JSON for offline reading (project list, document trees)
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Files stored in Backlog (attached and shared-file images) for offline viewing
CREATE TABLE IF NOT EXISTS assets (
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  project_id   INTEGER NOT NULL,
  title        TEXT NOT NULL,
  base_plain   TEXT,
  base_updated TEXT,
  base_hash    TEXT,
  local_plain  TEXT,
  read_only    INTEGER NOT NULL DEFAULT 0,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflict_copies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id    TEXT NOT NULL REFERENCES documents(id),
  local_plain    TEXT NOT NULL,
  remote_plain   TEXT NOT NULL,
  remote_updated TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
";

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

pub const SPACE_URL: &str = "space_url";
pub const PROJECT_KEY: &str = "project_key";

/// A document as stored locally.
#[derive(Debug, Clone)]
pub struct StoredDocument {
    pub id: String,
    pub project_id: i64,
    pub title: String,
    /// The last body known to be on Backlog, which local edits start from.
    pub base_plain: Option<String>,
    pub base_updated: Option<String>,
    /// Edits not yet published. `None` when the document matches the base.
    pub local_plain: Option<String>,
    /// Backlog could not regenerate the Markdown after this app's last update, so `base_plain`
    /// may be stale. Cleared when a fetch returns a different body.
    pub read_only: bool,
    pub fetched_at: String,
}

/// Local edits kept aside because Backlog changed while they were made (design §6.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConflictCopy {
    #[ts(type = "number")]
    pub id: i64,
    /// The local edits that were not published.
    pub local_plain: String,
    /// The body on Backlog at that time, which became the new base.
    pub remote_plain: String,
    /// ISO 8601
    pub remote_updated: String,
    /// ISO 8601
    pub created_at: String,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("database lock poisoned")
    }

    pub fn setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Drops everything fetched from a space (used when switching spaces).
    pub fn clear_space_data(&self) -> rusqlite::Result<()> {
        self.conn().execute_batch(
            "DELETE FROM conflict_copies;
             DELETE FROM documents;
             DELETE FROM cache;
             DELETE FROM assets;
             DELETE FROM settings WHERE key = 'project_key';",
        )
    }

    /// Stores a JSON value and returns its `fetched_at`.
    pub fn put_cache<T: Serialize>(&self, key: &str, value: &T) -> Result<String, CacheError> {
        let json = serde_json::to_string(value)?;
        let fetched_at = self.conn().query_row(
            &format!(
                "INSERT INTO cache (key, json, fetched_at) VALUES (?1, ?2, {NOW})
                 ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at
                 RETURNING fetched_at"
            ),
            params![key, json],
            |r| r.get(0),
        )?;
        Ok(fetched_at)
    }

    /// Returns the cached value and its `fetched_at`.
    pub fn cache<T: DeserializeOwned>(&self, key: &str) -> Result<Option<(T, String)>, CacheError> {
        let row: Option<(String, String)> = self
            .conn()
            .query_row(
                "SELECT json, fetched_at FROM cache WHERE key = ?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(json, at)| Ok((serde_json::from_str(&json)?, at)))
            .transpose()
    }

    /// Stores a downloaded file under `key`, replacing any earlier copy.
    pub fn put_asset(&self, key: &str, file: &FileContent) -> rusqlite::Result<()> {
        self.conn().execute(
            &format!(
                "INSERT INTO assets (key, content_type, bytes, fetched_at) VALUES (?1, ?2, ?3, {NOW})
                 ON CONFLICT(key) DO UPDATE SET
                   content_type = excluded.content_type,
                   bytes = excluded.bytes,
                   fetched_at = excluded.fetched_at"
            ),
            params![key, file.content_type, file.bytes],
        )?;
        Ok(())
    }

    pub fn asset(&self, key: &str) -> rusqlite::Result<Option<FileContent>> {
        self.conn()
            .query_row(
                "SELECT content_type, bytes FROM assets WHERE key = ?1",
                [key],
                |r| {
                    Ok(FileContent {
                        content_type: r.get(0)?,
                        bytes: r.get(1)?,
                    })
                },
            )
            .optional()
    }

    /// Saves a freshly fetched document. It becomes the new base only when there are no local
    /// edits: those edits started from the old base, and publishing compares against it.
    pub fn put_document(&self, doc: &backlog_api::Document) -> rusqlite::Result<StoredDocument> {
        self.conn().execute(
            &format!(
                "INSERT INTO documents (id, project_id, title, base_plain, base_updated, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, {NOW})
                 ON CONFLICT(id) DO UPDATE SET
                   project_id = excluded.project_id,
                   title = excluded.title,
                   fetched_at = excluded.fetched_at,
                   base_plain = iif(local_plain IS NULL, excluded.base_plain, base_plain),
                   base_updated = iif(local_plain IS NULL, excluded.base_updated, base_updated),
                   read_only = iif(local_plain IS NULL AND base_plain IS NOT excluded.base_plain,
                                   0, read_only)"
            ),
            params![doc.id, doc.project_id, doc.title, doc.plain, doc.updated],
        )?;
        self.document(&doc.id)
            .transpose()
            .expect("document was just inserted")
    }

    pub fn document(&self, id: &str) -> rusqlite::Result<Option<StoredDocument>> {
        self.conn()
            .query_row(
                "SELECT id, project_id, title, base_plain, base_updated, local_plain, read_only,
                        fetched_at
                 FROM documents WHERE id = ?1",
                [id],
                |r| {
                    Ok(StoredDocument {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        title: r.get(2)?,
                        base_plain: r.get(3)?,
                        base_updated: r.get(4)?,
                        local_plain: r.get(5)?,
                        read_only: r.get(6)?,
                        fetched_at: r.get(7)?,
                    })
                },
            )
            .optional()
    }

    /// Keeps `markdown` as the local edits. A body equal to the base clears them.
    /// Returns false when the document is not stored.
    pub fn save_local(&self, id: &str, markdown: &str) -> rusqlite::Result<bool> {
        let changed = self.conn().execute(
            "UPDATE documents SET local_plain = iif(coalesce(base_plain, '') = ?2, NULL, ?2)
             WHERE id = ?1",
            params![id, markdown],
        )?;
        Ok(changed > 0)
    }

    pub fn discard_local(&self, id: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE documents SET local_plain = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    /// Makes `remote` the new base after a publish attempt that used the local body `sent`.
    /// The local edits are cleared only if they are still `sent`, so edits saved meanwhile stay.
    pub fn settle(
        &self,
        remote: &backlog_api::Document,
        sent: &str,
        read_only: bool,
    ) -> rusqlite::Result<()> {
        settle(&self.conn(), remote, sent, read_only)
    }

    /// Keeps the local body `sent` as a conflict copy and makes `remote` the new base.
    pub fn record_conflict(
        &self,
        remote: &backlog_api::Document,
        sent: &str,
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            &format!(
                "INSERT INTO conflict_copies
                   (document_id, local_plain, remote_plain, remote_updated, created_at)
                 VALUES (?1, ?2, ?3, ?4, {NOW})"
            ),
            params![
                remote.id,
                sent,
                remote.plain.as_deref().unwrap_or_default(),
                remote.updated
            ],
        )?;
        settle(&tx, remote, sent, false)?;
        tx.commit()
    }

    /// Unresolved conflict copies of a document, oldest first.
    pub fn conflict_copies(&self, document_id: &str) -> rusqlite::Result<Vec<ConflictCopy>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, local_plain, remote_plain, remote_updated, created_at
             FROM conflict_copies WHERE document_id = ?1 AND resolved_at IS NULL ORDER BY id",
        )?;
        let copies = stmt.query_map([document_id], |r| {
            Ok(ConflictCopy {
                id: r.get(0)?,
                local_plain: r.get(1)?,
                remote_plain: r.get(2)?,
                remote_updated: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        copies.collect()
    }

    pub fn resolve_conflict(&self, document_id: &str, copy_id: i64) -> rusqlite::Result<()> {
        self.conn().execute(
            &format!(
                "UPDATE conflict_copies SET resolved_at = {NOW}
                 WHERE id = ?1 AND document_id = ?2 AND resolved_at IS NULL"
            ),
            params![copy_id, document_id],
        )?;
        Ok(())
    }
}

fn settle(
    conn: &Connection,
    remote: &backlog_api::Document,
    sent: &str,
    read_only: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "UPDATE documents SET
               title = ?2,
               base_plain = ?3,
               base_updated = ?4,
               read_only = ?5,
               local_plain = iif(local_plain IS ?6, NULL, local_plain),
               fetched_at = {NOW}
             WHERE id = ?1"
        ),
        params![
            remote.id,
            remote.title,
            remote.plain,
            remote.updated,
            read_only,
            sent
        ],
    )?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(plain: &str, updated: &str) -> backlog_api::Document {
        backlog_api::Document {
            id: "d1".into(),
            project_id: 1,
            title: "title".into(),
            plain: Some(plain.into()),
            created: "2026-01-01T00:00:00Z".into(),
            updated: updated.into(),
        }
    }

    #[test]
    fn settings_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.setting(SPACE_URL).unwrap(), None);
        store
            .set_setting(SPACE_URL, "https://a.backlog.jp")
            .unwrap();
        store
            .set_setting(SPACE_URL, "https://b.backlog.jp")
            .unwrap();
        assert_eq!(
            store.setting(SPACE_URL).unwrap().as_deref(),
            Some("https://b.backlog.jp")
        );
    }

    #[test]
    fn cache_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        let fetched_at = store.put_cache("k", &vec![1, 2, 3]).unwrap();
        let (value, at): (Vec<i32>, String) = store.cache("k").unwrap().unwrap();
        assert_eq!(value, vec![1, 2, 3]);
        assert_eq!(at, fetched_at);
        assert!(store.cache::<Vec<i32>>("missing").unwrap().is_none());
    }

    fn file(content_type: &str, bytes: &[u8]) -> FileContent {
        FileContent {
            content_type: content_type.into(),
            bytes: bytes.into(),
        }
    }

    #[test]
    fn asset_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.asset("attachment/d1/1").unwrap(), None);
        let png = file("image/png", &[0x89, b'P', b'N', b'G', 0, 0xff]);
        store.put_asset("attachment/d1/1", &png).unwrap();
        assert_eq!(store.asset("attachment/d1/1").unwrap(), Some(png));
        assert_eq!(store.asset("attachment/d1/2").unwrap(), None);
    }

    #[test]
    fn put_asset_replaces_earlier_copy() {
        let store = Store::open_in_memory().unwrap();
        store
            .put_asset("shared-file/PRJ/1", &file("image/png", b"old"))
            .unwrap();
        let new = file("image/jpeg", b"new");
        store.put_asset("shared-file/PRJ/1", &new).unwrap();
        assert_eq!(store.asset("shared-file/PRJ/1").unwrap(), Some(new));
    }

    #[test]
    fn put_document_updates_base() {
        let store = Store::open_in_memory().unwrap();
        store
            .put_document(&doc("v1", "2026-01-01T00:00:00Z"))
            .unwrap();
        let stored = store
            .put_document(&doc("v2", "2026-01-02T00:00:00Z"))
            .unwrap();
        assert_eq!(stored.base_plain.as_deref(), Some("v2"));
        assert_eq!(stored.base_updated.as_deref(), Some("2026-01-02T00:00:00Z"));
    }

    const T1: &str = "2026-01-01T00:00:00Z";
    const T2: &str = "2026-01-02T00:00:00Z";

    /// A store holding document `d1` with body `v1` at `T1`.
    fn store_with_v1() -> Store {
        let store = Store::open_in_memory().unwrap();
        store.put_document(&doc("v1", T1)).unwrap();
        store
    }

    fn stored(store: &Store) -> StoredDocument {
        store.document("d1").unwrap().unwrap()
    }

    #[test]
    fn put_document_keeps_base_while_edited() {
        let store = store_with_v1();
        store.save_local("d1", "mine").unwrap();
        let mut renamed = doc("v2", T2);
        renamed.title = "renamed".into();
        let d = store.put_document(&renamed).unwrap();
        assert_eq!(d.base_plain.as_deref(), Some("v1"));
        assert_eq!(d.base_updated.as_deref(), Some(T1));
        assert_eq!(d.local_plain.as_deref(), Some("mine"));
        assert_eq!(d.title, "renamed");
    }

    #[test]
    fn save_local_equal_to_base_clears_edits() {
        let store = store_with_v1();
        assert!(store.save_local("d1", "v1 edited").unwrap());
        assert_eq!(stored(&store).local_plain.as_deref(), Some("v1 edited"));
        store.save_local("d1", "v1").unwrap();
        assert_eq!(stored(&store).local_plain, None);
        assert!(!store.save_local("missing", "x").unwrap());
    }

    #[test]
    fn discard_local_clears_edits() {
        let store = store_with_v1();
        store.save_local("d1", "mine").unwrap();
        store.discard_local("d1").unwrap();
        assert_eq!(stored(&store).local_plain, None);
        assert_eq!(stored(&store).base_plain.as_deref(), Some("v1"));
    }

    #[test]
    fn settle_clears_only_the_edits_that_were_sent() {
        let store = store_with_v1();
        store.save_local("d1", "sent").unwrap();
        store.save_local("d1", "typed while publishing").unwrap();
        store.settle(&doc("sent\n", T2), "sent", false).unwrap();
        let d = stored(&store);
        assert_eq!(d.base_plain.as_deref(), Some("sent\n"));
        assert_eq!(d.base_updated.as_deref(), Some(T2));
        assert_eq!(d.local_plain.as_deref(), Some("typed while publishing"));

        store
            .settle(&doc("typed\n", T2), "typed while publishing", false)
            .unwrap();
        assert_eq!(stored(&store).local_plain, None);
    }

    #[test]
    fn record_conflict_keeps_a_copy_and_adopts_the_remote() {
        let store = store_with_v1();
        store.save_local("d1", "mine").unwrap();
        store.record_conflict(&doc("theirs", T2), "mine").unwrap();
        let d = stored(&store);
        assert_eq!(d.base_plain.as_deref(), Some("theirs"));
        assert_eq!(d.local_plain, None);
        let copies = store.conflict_copies("d1").unwrap();
        assert_eq!(copies.len(), 1);
        assert_eq!(copies[0].local_plain, "mine");
        assert_eq!(copies[0].remote_plain, "theirs");
        assert_eq!(copies[0].remote_updated, T2);

        store.resolve_conflict("d1", copies[0].id).unwrap();
        assert!(store.conflict_copies("d1").unwrap().is_empty());
    }

    #[test]
    fn read_only_lasts_until_a_fetch_returns_a_different_body() {
        let store = store_with_v1();
        store.settle(&doc("v1", T2), "", true).unwrap();
        assert!(store.put_document(&doc("v1", T2)).unwrap().read_only);
        assert!(!store.put_document(&doc("v3", T2)).unwrap().read_only);
    }

    #[test]
    fn clear_space_data_keeps_space_url() {
        let store = Store::open_in_memory().unwrap();
        store
            .set_setting(SPACE_URL, "https://a.backlog.jp")
            .unwrap();
        store.set_setting(PROJECT_KEY, "PROJ").unwrap();
        store.put_cache("k", &1).unwrap();
        store.put_asset("a", &file("image/png", b"x")).unwrap();
        store
            .put_document(&doc("v1", "2026-01-01T00:00:00Z"))
            .unwrap();
        store.clear_space_data().unwrap();
        assert!(store.setting(SPACE_URL).unwrap().is_some());
        assert!(store.setting(PROJECT_KEY).unwrap().is_none());
        assert!(store.cache::<i32>("k").unwrap().is_none());
        assert!(store.asset("a").unwrap().is_none());
        assert!(store.document("d1").unwrap().is_none());
    }
}
