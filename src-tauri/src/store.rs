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

-- Bodies kept whenever text would leave the editor (discard, merge, restore), so nothing
-- written is ever lost. The newest `VERSIONS_KEPT` per document are kept.
CREATE TABLE IF NOT EXISTS versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  plain       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
";

/// Earlier releases kept unpublished edits as conflict copies. They become versions.
const MIGRATE_CONFLICT_COPIES: &str = "
INSERT INTO versions (document_id, plain, reason, created_at)
  SELECT document_id, local_plain, 'conflict', created_at FROM conflict_copies ORDER BY id;
DROP TABLE conflict_copies;
";

/// How many versions are kept per document.
pub const VERSIONS_KEPT: usize = 20;

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

/// A body kept before it left the editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Version {
    #[ts(type = "number")]
    pub id: i64,
    pub plain: String,
    pub reason: VersionReason,
    /// ISO 8601
    pub created_at: String,
}

/// Why a version was kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VersionReason {
    /// The edits were discarded.
    Discarded,
    /// The edits before Backlog's changes were merged into them.
    BeforeMerge,
    /// The edits before a version was restored over them.
    BeforeRestore,
    /// Edits kept as a conflict copy by an earlier release.
    Conflict,
}

impl VersionReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Discarded => "discarded",
            Self::BeforeMerge => "beforeMerge",
            Self::BeforeRestore => "beforeRestore",
            Self::Conflict => "conflict",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "discarded" => Self::Discarded,
            "beforeMerge" => Self::BeforeMerge,
            "beforeRestore" => Self::BeforeRestore,
            _ => Self::Conflict,
        }
    }
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(SCHEMA)?;
        let has_conflict_copies: bool = conn.query_row(
            "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'conflict_copies'",
            [],
            |r| r.get(0),
        )?;
        if has_conflict_copies {
            let tx = conn.transaction()?;
            tx.execute_batch(MIGRATE_CONFLICT_COPIES)?;
            tx.commit()?;
        }
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
            "DELETE FROM versions;
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

    /// Drops the local edits, keeping them as a version first.
    pub fn discard_local(&self, id: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some(local) = local_plain(&tx, id)? {
            add_version(&tx, id, &local, VersionReason::Discarded)?;
        }
        tx.execute(
            "UPDATE documents SET local_plain = NULL WHERE id = ?1",
            [id],
        )?;
        tx.commit()
    }

    /// Keeps `plain` as a version of the document.
    pub fn add_version(
        &self,
        id: &str,
        plain: &str,
        reason: VersionReason,
    ) -> rusqlite::Result<()> {
        add_version(&self.conn(), id, plain, reason)
    }

    /// Moves the local edits onto a newer base: `base_plain` at `base_updated` becomes the base
    /// and `local` the edits. The edits being replaced are kept as a version first (`reason`).
    pub fn rebase(
        &self,
        id: &str,
        base_plain: &str,
        base_updated: &str,
        local: &str,
        reason: VersionReason,
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if let Some(old) = local_plain(&tx, id)?
            && old != local
        {
            add_version(&tx, id, &old, reason)?;
        }
        tx.execute(
            &format!(
                "UPDATE documents SET
                   base_plain = ?2,
                   base_updated = ?3,
                   local_plain = iif(?2 = ?4, NULL, ?4),
                   read_only = 0,
                   fetched_at = {NOW}
                 WHERE id = ?1"
            ),
            params![id, base_plain, base_updated, local],
        )?;
        tx.commit()
    }

    /// The document's kept versions, newest first.
    pub fn versions(&self, id: &str) -> rusqlite::Result<Vec<Version>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, plain, reason, created_at FROM versions
             WHERE document_id = ?1 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok(Version {
                id: r.get(0)?,
                plain: r.get(1)?,
                reason: VersionReason::parse(&r.get::<_, String>(2)?),
                created_at: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn version_count(&self, id: &str) -> rusqlite::Result<u32> {
        self.conn().query_row(
            "SELECT count(*) FROM versions WHERE document_id = ?1",
            [id],
            |r| r.get(0),
        )
    }

    /// Makes a kept version the local edits. The edits it replaces are kept as a version first.
    /// Returns false when there is no such version.
    pub fn restore_version(&self, id: &str, version_id: i64) -> rusqlite::Result<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let plain: Option<String> = tx
            .query_row(
                "SELECT plain FROM versions WHERE id = ?1 AND document_id = ?2",
                params![version_id, id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(plain) = plain else {
            return Ok(false);
        };
        if let Some(old) = local_plain(&tx, id)?
            && old != plain
        {
            add_version(&tx, id, &old, VersionReason::BeforeRestore)?;
        }
        tx.execute(
            "UPDATE documents SET local_plain = iif(coalesce(base_plain, '') = ?2, NULL, ?2)
             WHERE id = ?1",
            params![id, plain],
        )?;
        tx.commit()?;
        Ok(true)
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

fn local_plain(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT local_plain FROM documents WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

/// Keeps `plain` unless it is already the newest version, then drops versions beyond
/// `VERSIONS_KEPT`.
fn add_version(
    conn: &Connection,
    id: &str,
    plain: &str,
    reason: VersionReason,
) -> rusqlite::Result<()> {
    let newest: Option<String> = conn
        .query_row(
            "SELECT plain FROM versions WHERE document_id = ?1 ORDER BY id DESC LIMIT 1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if newest.as_deref() == Some(plain) {
        return Ok(());
    }
    conn.execute(
        &format!(
            "INSERT INTO versions (document_id, plain, reason, created_at)
             VALUES (?1, ?2, ?3, {NOW})"
        ),
        params![id, plain, reason.as_str()],
    )?;
    conn.execute(
        "DELETE FROM versions WHERE document_id = ?1 AND id NOT IN
           (SELECT id FROM versions WHERE document_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![id, VERSIONS_KEPT as i64],
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
    fn discarding_keeps_the_edits_as_a_version() {
        let store = store_with_v1();
        store.save_local("d1", "a lot of writing").unwrap();
        store.discard_local("d1").unwrap();
        assert_eq!(stored(&store).local_plain, None);
        let versions = store.versions("d1").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].plain, "a lot of writing");
        assert_eq!(versions[0].reason, VersionReason::Discarded);
        // Discarding with no edits keeps nothing.
        store.discard_local("d1").unwrap();
        assert_eq!(store.version_count("d1").unwrap(), 1);
    }

    #[test]
    fn restoring_keeps_the_edits_it_replaces() {
        let store = store_with_v1();
        store.save_local("d1", "first draft").unwrap();
        store.discard_local("d1").unwrap();
        store.save_local("d1", "second draft").unwrap();
        let first = store.versions("d1").unwrap()[0].id;
        assert!(store.restore_version("d1", first).unwrap());
        assert_eq!(stored(&store).local_plain.as_deref(), Some("first draft"));
        let versions = store.versions("d1").unwrap();
        assert_eq!(versions[0].plain, "second draft");
        assert_eq!(versions[0].reason, VersionReason::BeforeRestore);
        assert!(!store.restore_version("d1", 9999).unwrap());
    }

    #[test]
    fn rebase_moves_the_edits_onto_the_new_base_and_keeps_the_old_ones() {
        let store = store_with_v1();
        store.save_local("d1", "mine").unwrap();
        store
            .rebase(
                "d1",
                "theirs",
                T2,
                "theirs and mine",
                VersionReason::BeforeMerge,
            )
            .unwrap();
        let d = stored(&store);
        assert_eq!(d.base_plain.as_deref(), Some("theirs"));
        assert_eq!(d.base_updated.as_deref(), Some(T2));
        assert_eq!(d.local_plain.as_deref(), Some("theirs and mine"));
        assert_eq!(store.versions("d1").unwrap()[0].plain, "mine");
        // A merge that equals the new base leaves no edits.
        store
            .rebase("d1", "same", T2, "same", VersionReason::BeforeMerge)
            .unwrap();
        assert_eq!(stored(&store).local_plain, None);
    }

    #[test]
    fn keeps_the_newest_versions_and_skips_repeats() {
        let store = store_with_v1();
        for n in 0..VERSIONS_KEPT + 5 {
            store
                .add_version("d1", &format!("v{n}"), VersionReason::Discarded)
                .unwrap();
        }
        store
            .add_version(
                "d1",
                &format!("v{}", VERSIONS_KEPT + 4),
                VersionReason::Discarded,
            )
            .unwrap();
        let versions = store.versions("d1").unwrap();
        assert_eq!(versions.len(), VERSIONS_KEPT);
        assert_eq!(versions[0].plain, format!("v{}", VERSIONS_KEPT + 4));
        assert_eq!(versions.last().unwrap().plain, "v5");
    }

    #[test]
    fn conflict_copies_from_earlier_releases_become_versions() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conflict_copies (
               id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL,
               local_plain TEXT NOT NULL, remote_plain TEXT NOT NULL,
               remote_updated TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
             INSERT INTO conflict_copies (document_id, local_plain, remote_plain, remote_updated, created_at, resolved_at)
               VALUES ('d1', 'mine', 'theirs', 'T', '2026-11-20T00:00:00Z', NULL),
                      ('d1', 'older mine', 'theirs', 'T', '2026-11-19T00:00:00Z', '2026-11-19T01:00:00Z');",
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        let versions = store.versions("d1").unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions.iter().all(|v| v.reason == VersionReason::Conflict));
        assert!(versions.iter().any(|v| v.plain == "older mine"));
        // Opening again does not migrate twice.
        let conn = store.conn.into_inner().unwrap();
        assert_eq!(Store::init(conn).unwrap().version_count("d1").unwrap(), 2);
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
