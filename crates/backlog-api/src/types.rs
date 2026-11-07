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

#[cfg(test)]
mod tests {
    use super::*;

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
}
