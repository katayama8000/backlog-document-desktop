use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct User {
    pub id: i64,
    #[serde(default)]
    pub user_id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    pub id: i64,
    pub project_key: String,
    pub name: String,
    #[serde(default)]
    pub use_document: Option<bool>,
    #[serde(default)]
    pub archived: bool,
}

/// Response of `GET /api/v2/documents/tree`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DocumentTree {
    pub project_id: i64,
    pub active_tree: TreeNode,
}

/// A node of the document tree. The root node has id `"Active"` and no name.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TreeNode {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub children: Vec<TreeNode>,
}

/// Response of `GET /api/v2/documents/:id` (only the fields this app uses).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Document {
    pub id: String,
    pub project_id: i64,
    pub title: String,
    /// Normalized Pandoc Markdown of the body.
    #[serde(default)]
    pub plain: Option<String>,
    /// ISO 8601
    pub created: String,
    /// ISO 8601
    pub updated: String,
}

/// An item of `GET /api/v2/documents`: only what is needed to tell whether a document changed.
/// The response also carries each document's body, which is ignored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DocumentSummary {
    pub id: String,
    pub title: String,
    /// ISO 8601
    pub updated: String,
}

/// Response of `PATCH /api/v2/documents/:id/content`. It has no body: fetch the document again.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentUpdate {
    /// The body was saved, but Backlog could not regenerate its Markdown, so `plain` may stay
    /// stale even when fetched again.
    #[serde(default)]
    pub markdown_is_fallback: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_document_summaries_ignoring_the_body() {
        let json = r#"[{
            "id": "0123456789abcdef0123456789abcdef",
            "projectId": 1,
            "title": "top",
            "plain": "A big body",
            "json": "{}",
            "statusId": 1,
            "emoji": null,
            "attachments": [],
            "tags": [],
            "created": "2025-04-28T01:47:02Z",
            "updated": "2026-11-20T03:00:00Z"
        }]"#;
        let docs: Vec<DocumentSummary> = serde_json::from_str(json).unwrap();
        assert_eq!(docs[0].title, "top");
        assert_eq!(docs[0].updated, "2026-11-20T03:00:00Z");
    }

    #[test]
    fn decodes_document_tree() {
        let json = r#"{
            "projectId": 1,
            "activeTree": {
                "id": "Active",
                "children": [
                    {"id": "a1", "name": "top", "emoji": null, "children": [
                        {"id": "a2", "name": "child", "emoji": "📝", "children": []}
                    ]}
                ]
            },
            "trashTree": {"id": "Trash", "children": []}
        }"#;
        let tree: DocumentTree = serde_json::from_str(json).unwrap();
        assert_eq!(tree.active_tree.id, "Active");
        assert_eq!(tree.active_tree.name, None);
        assert_eq!(
            tree.active_tree.children[0].children[0].name.as_deref(),
            Some("child")
        );
    }

    #[test]
    fn decodes_document_ignoring_unused_fields() {
        let json = r##"{
            "id": "0123456789abcdef0123456789abcdef",
            "projectId": 1,
            "title": "top",
            "plain": "# head {#abc}\n\nhello",
            "json": "{}",
            "statusId": 1,
            "emoji": null,
            "attachments": [],
            "tags": [{"id": 1, "name": "Backlog"}],
            "createdUser": {"id": 1, "name": "admin"},
            "created": "2025-04-28T01:47:02Z",
            "updatedUser": {"id": 1, "name": "admin"},
            "updated": "2025-04-28T01:47:02Z"
        }"##;
        let doc: Document = serde_json::from_str(json).unwrap();
        assert_eq!(doc.title, "top");
        assert!(doc.plain.unwrap().contains("{#abc}"));
    }

    #[test]
    fn decodes_content_update() {
        let json = r#"{
            "id": "0123456789abcdef0123456789abcdef",
            "projectId": 1,
            "title": "top",
            "json": "{}",
            "statusId": 1,
            "created": "2025-04-28T01:47:02Z",
            "updated": "2026-11-20T03:00:00Z",
            "markdownIsFallback": true
        }"#;
        let update: ContentUpdate = serde_json::from_str(json).unwrap();
        assert!(update.markdown_is_fallback);
    }

    #[test]
    fn content_update_without_fallback_flag_is_not_fallback() {
        let json =
            r#"{"id": "0123456789abcdef0123456789abcdef", "updated": "2026-11-20T03:00:00Z"}"#;
        let update: ContentUpdate = serde_json::from_str(json).unwrap();
        assert!(!update.markdown_is_fallback);
    }
}
