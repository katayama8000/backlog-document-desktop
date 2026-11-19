//! Minimal Backlog API client covering what backlog-document-desktop needs.

mod client;
mod error;
mod space_url;
mod types;

pub use client::{Client, FileContent};
pub use error::{ApiErrorItem, Error};
pub use space_url::SpaceUrl;
pub use types::{Document, DocumentTree, Project, TreeNode, User};
