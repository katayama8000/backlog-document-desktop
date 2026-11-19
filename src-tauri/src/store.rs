//! Local SQLite cache (see docs/design.md §7).

use std::path::Path;
use std::sync::Mutex;

use backlog_api::FileContent;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

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
    pub base_plain: Option<String>,
    pub base_updated: Option<String>,
    pub fetched_at: String,
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

    /// Saves a freshly fetched document as the new base. Local edits are kept.
    pub fn put_document(&self, doc: &backlog_api::Document) -> rusqlite::Result<StoredDocument> {
        self.conn().execute(
            &format!(
                "INSERT INTO documents (id, project_id, title, base_plain, base_updated, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, {NOW})
                 ON CONFLICT(id) DO UPDATE SET
                   project_id = excluded.project_id,
                   title = excluded.title,
                   base_plain = excluded.base_plain,
                   base_updated = excluded.base_updated,
                   fetched_at = excluded.fetched_at"
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
                "SELECT id, project_id, title, base_plain, base_updated, fetched_at
                 FROM documents WHERE id = ?1",
                [id],
                |r| {
                    Ok(StoredDocument {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        title: r.get(2)?,
                        base_plain: r.get(3)?,
                        base_updated: r.get(4)?,
                        fetched_at: r.get(5)?,
                    })
                },
            )
            .optional()
    }
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
