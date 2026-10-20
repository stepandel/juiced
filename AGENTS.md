# Project instructions

- Commit all code changes before finishing a task.
- In a linked Git worktree, use a dedicated branch for the task. If HEAD is detached, create the branch from the current HEAD before making changes.
- Keep `main` checked out only in the primary repository checkout. Never reuse a branch checked out in another worktree or bypass Git's protection with `--ignore-other-worktrees` or `git worktree add --force`.
- Merge or fast-forward completed work into `main` only when the user asks, and do it from the clean primary checkout. Do not move a branch checked out in another worktree.
