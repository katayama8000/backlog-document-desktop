use std::sync::Mutex;

use backlog_api::Client;

use crate::error::CommandError;
use crate::store::Store;

pub struct AppState {
    pub store: Store,
    client: Mutex<Option<Client>>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            client: Mutex::new(None),
        }
    }

    /// Returns a clone of the configured client (cheap: reqwest clients share a pool).
    pub fn client(&self) -> Result<Client, CommandError> {
        self.client
            .lock()
            .expect("client lock poisoned")
            .clone()
            .ok_or_else(CommandError::not_configured)
    }

    pub fn set_client(&self, client: Client) {
        *self.client.lock().expect("client lock poisoned") = Some(client);
    }
}
