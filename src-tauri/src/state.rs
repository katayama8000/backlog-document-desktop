use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use backlog_api::{Client, SpaceUrl};
use tokio::task::AbortHandle;

use crate::error::CommandError;
use crate::store::Store;

pub struct AppState {
    pub store: Store,
    client: Mutex<Option<Client>>,
    /// The OAuth sign-in in progress, if any.
    sign_in: Mutex<Option<SignIn>>,
    next_sign_in: AtomicU64,
}

struct SignIn {
    id: u64,
    /// The task waiting for the browser, once it has started.
    waiting: Option<AbortHandle>,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            client: Mutex::new(None),
            sign_in: Mutex::new(None),
            next_sign_in: AtomicU64::new(1),
        }
    }

    /// Starts an OAuth sign-in, replacing (and stopping) one still in progress.
    pub fn start_sign_in(&self) -> u64 {
        let id = self.next_sign_in.fetch_add(1, Ordering::SeqCst);
        let previous = self
            .sign_in
            .lock()
            .expect("sign-in lock poisoned")
            .replace(SignIn { id, waiting: None });
        if let Some(waiting) = previous.and_then(|p| p.waiting) {
            waiting.abort();
        }
        id
    }

    /// Records the task waiting for the browser. Stops it at once if the sign-in was
    /// cancelled meanwhile.
    pub fn wait_for_browser(&self, id: u64, waiting: AbortHandle) {
        let mut sign_in = self.sign_in.lock().expect("sign-in lock poisoned");
        match sign_in.as_mut() {
            Some(current) if current.id == id => current.waiting = Some(waiting),
            _ => waiting.abort(),
        }
    }

    /// Cancels the sign-in in progress at whatever step it is: waiting for the browser
    /// stops at once (freeing the port); later steps finish without saving anything.
    pub fn cancel_sign_in(&self) {
        let cancelled = self.sign_in.lock().expect("sign-in lock poisoned").take();
        if let Some(waiting) = cancelled.and_then(|c| c.waiting) {
            waiting.abort();
        }
    }

    /// Ends sign-in `id`. False when it was cancelled or replaced, so it must not be saved.
    pub fn finish_sign_in(&self, id: u64) -> bool {
        let mut sign_in = self.sign_in.lock().expect("sign-in lock poisoned");
        if sign_in.as_ref().is_some_and(|current| current.id == id) {
            *sign_in = None;
            true
        } else {
            false
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

    /// The configured client, if it is for `space_url`.
    pub fn client_for(&self, space_url: &SpaceUrl) -> Option<Client> {
        self.client
            .lock()
            .expect("client lock poisoned")
            .clone()
            .filter(|client| client.space_url() == space_url)
    }

    /// Replaces the client. The old one's OAuth session stops storing tokens, so requests
    /// still under way cannot overwrite the new credentials.
    pub fn set_client(&self, client: Client) {
        let old = self
            .client
            .lock()
            .expect("client lock poisoned")
            .replace(client);
        if let Some(old) = old {
            old.retire();
        }
    }
}
