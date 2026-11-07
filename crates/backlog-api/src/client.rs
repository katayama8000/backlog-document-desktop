use std::time::Duration;

use reqwest::StatusCode;
use serde::de::DeserializeOwned;

use crate::error::ApiErrorBody;
use crate::{Document, DocumentTree, Error, Project, SpaceUrl, User};

const TIMEOUT: Duration = Duration::from_secs(15);

/// Backlog API client authenticated with an API key.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    space_url: SpaceUrl,
    api_key: String,
}

impl Client {
    pub fn new(space_url: SpaceUrl, api_key: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!(
                "backlog-document-desktop/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .expect("failed to build HTTP client");
        Self {
            http,
            space_url,
            api_key: api_key.into(),
        }
    }

    pub fn space_url(&self) -> &SpaceUrl {
        &self.space_url
    }

    /// `GET /api/v2/users/myself` — used to verify the connection settings.
    pub async fn myself(&self) -> Result<User, Error> {
        self.get("/api/v2/users/myself", &[]).await
    }

    /// `GET /api/v2/projects` (joined, not archived).
    pub async fn projects(&self) -> Result<Vec<Project>, Error> {
        self.get("/api/v2/projects", &[("archived", "false")]).await
    }

    /// `GET /api/v2/documents/tree`
    pub async fn document_tree(&self, project_id_or_key: &str) -> Result<DocumentTree, Error> {
        self.get(
            "/api/v2/documents/tree",
            &[("projectIdOrKey", project_id_or_key)],
        )
        .await
    }

    /// `GET /api/v2/documents/:documentId`
    pub async fn document(&self, document_id: &str) -> Result<Document, Error> {
        let path = format!("/api/v2/documents/{document_id}");
        self.get(&path, &[]).await
    }

    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, Error> {
        let response = self
            .http
            .get(format!("{}{}", self.space_url, path))
            .query(&[("apiKey", self.api_key.as_str())])
            .query(query)
            .send()
            .await
            .map_err(Error::Network)?;
        decode(response).await
    }
}

async fn decode<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, Error> {
    let status = response.status();
    if status.is_success() {
        return response.json::<T>().await.map_err(Error::Decode);
    }
    let errors = match response.json::<ApiErrorBody>().await {
        Ok(body) => body.errors,
        Err(_) => Vec::new(),
    };
    Err(Error::Api {
        status: status.as_u16(),
        errors,
    })
}

impl Error {
    /// True for authentication failures (wrong or revoked API key).
    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(StatusCode::UNAUTHORIZED.as_u16())
    }
}
