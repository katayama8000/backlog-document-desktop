//! Sync decisions for Backlog documents (docs/design.md §6). Pure functions: no network, no
//! database.

/// A document body as Backlog stores it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Snapshot<'a> {
    /// Normalized Markdown (`plain`).
    pub plain: &'a str,
    /// `updated` (ISO 8601, whole seconds).
    pub updated: &'a str,
}

/// What "Publish to Backlog" does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushPlan {
    /// Send this body.
    Send(String),
    /// Backlog changed since the local edits started: keep them aside as a conflict copy.
    Conflict,
    /// Backlog already has the local body, or there are no local edits: adopt the remote.
    NothingToSend,
}

/// Decides from `base` (the server copy the local edits started from), `local` and the current
/// `remote`.
///
/// The remote counts as unchanged only when both `updated` and the body match `base`. `updated`
/// has whole-second resolution, so two edits in one second differ only in the body; and after an
/// update whose Markdown Backlog could not regenerate, the body can stay stale while `updated`
/// moves.
pub fn plan_push(base: Snapshot, local: &str, remote: Snapshot) -> PushPlan {
    if local == remote.plain || local == base.plain {
        PushPlan::NothingToSend
    } else if remote == base {
        PushPlan::Send(local.to_owned())
    } else {
        PushPlan::Conflict
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T1: &str = "2026-11-20T01:00:00Z";
    const T2: &str = "2026-11-20T01:05:00Z";

    fn at<'a>(plain: &'a str, updated: &'a str) -> Snapshot<'a> {
        Snapshot { plain, updated }
    }

    #[test]
    fn plan_push_table() {
        let send = |s: &str| PushPlan::Send(s.to_owned());
        #[rustfmt::skip]
        let cases = [
            // (name, base, local, remote, expected)
            ("remote unchanged",                       at("a", T1), "a b", at("a", T1),   send("a b")),
            ("remote body changed",                    at("a", T1), "a b", at("a c", T2), PushPlan::Conflict),
            ("remote body changed in the same second", at("a", T1), "a b", at("a c", T1), PushPlan::Conflict),
            ("remote updated moved, body unchanged",   at("a", T1), "a b", at("a", T2),   PushPlan::Conflict),
            ("local equals remote",                    at("a", T1), "a b", at("a b", T2), PushPlan::NothingToSend),
            ("local equals base, remote unchanged",    at("a", T1), "a",   at("a", T1),   PushPlan::NothingToSend),
            ("local equals base, remote changed",      at("a", T1), "a",   at("a c", T2), PushPlan::NothingToSend),
            ("empty document gets a body",             at("", T1),  "a",   at("", T1),    send("a")),
            ("local clears the body",                  at("a", T1), "",    at("a", T1),   send("")),
        ];
        for (name, base, local, remote, expected) in cases {
            assert_eq!(plan_push(base, local, remote), expected, "{name}");
        }
    }
}
