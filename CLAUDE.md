@AGENTS.md

## Claude Code

- Parallel subagents work in worktrees under `.claude/worktrees/` (git-ignored). Give each one disjoint files; split shared files first if needed.
- A subagent that runs `pnpm tauri dev` from a worktree must override the app `identifier` with a throwaway value and use a free dev port. This keeps it off the user's store and Keychain, which would otherwise prompt for the login password on every rebuild. Never enter or approve a Keychain prompt.
- Verify a subagent's PR yourself before merging: rerun the checks on its branch merged onto the current `main`, and read the risky parts of the diff.
