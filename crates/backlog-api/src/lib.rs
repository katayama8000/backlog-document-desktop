//! Minimal Backlog API client covering what backlog-document-desktop needs.

mod client;
mod error;
pub mod oauth;
mod space_url;
mod types;

pub use client::{Auth, Client, FileContent, OAuthSession};
pub use error::{ApiErrorItem, Error};
pub use space_url::SpaceUrl;
pub use types::{ContentUpdate, Document, DocumentSummary, DocumentTree, Project, TreeNode, User};
