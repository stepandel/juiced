# Using Juiced

`juiced claude` opens the Juiced TUI on your machine, connected to a headless
Claude Code process in a persistent cloud workspace. Typing, cursor movement,
multiline editing, and pasting happen locally. Submitted prompts, menu data
requests, confirmed actions, permission answers, and interrupts cross the
network. Claude's agent loop, tools, files, and authentication stay in the
remote workspace.

## Claude sign-in

Sign in to Claude once per workspace:

```sh
juiced claude login
juiced claude
```

`juiced claude login` prints Claude's sign-in URL and asks for the returned
authorization code. The native Claude login runs remotely; credentials persist in
the workspace. Interactive `juiced claude` also starts this login flow when
needed. Piped commands require an existing login.

Commands that use a harness's runtime and authentication live under its name.
Claude sign-in is `juiced claude login`. In managed mode, `juiced login` signs in
to your Juiced account separately; see [managed service](managed-service.md).
`juiced claude --version` and `juiced claude --help` work before Claude sign-in
and can verify connectivity to the deployed runtime.

The local UI uses Claude's programmatic mode in the selected workspace. It does
not run native terminal onboarding or show a remote folder-trust dialog. Claude's
own tool permission checks remain active. Permission grants apply once, without
changing stored permission rules. `AskUserQuestion` prompts accept a typed answer
or an option number.

## Commands and arguments

Arguments after `claude` configure the remote Claude process, except for
Juiced's reserved `login`, `sync`, `fast-forward`, `delete`, `ls`, `peek`, and
`sessions` subcommands and the leading `--new` and `--session ID` options. Use
`juiced claude -- login` to send a literal prompt named `login`. Interactive
launches add the JSON transport flags needed by the local UI. Explicit
print/introspection/output-format invocations use native passthrough:

```sh
juiced claude --model sonnet
juiced claude --new # Start fresh and replace this terminal tab's session binding
juiced claude sessions # List saved Juiced conversations, newest first
juiced claude --session ses_<id> # Reopen a listed conversation
juiced claude --help
juiced claude -p "Explain the repository in this workspace"
cat prompt.txt | juiced claude -p
juiced claude -p "Summarize the project" > summary.txt
```

## Sessions

Each terminal tab has its own session. Run `juiced claude` in a new tab to start
another session alongside the ones you already have; there's no need to finish
or detach one before opening the next. Rerunning `juiced claude` in the same
tab, project, and workspace reconnects to that tab's session. The session ID is
displayed in the session header.

Terminal bindings use a terminal session ID, a tmux/screen pane ID, or the parent
shell's PID and start time. Each tab, local project directory, and canonical
remote workspace gets a separate binding. Deleting and recreating a workspace
starts fresh. Only session IDs are saved locally in `.cantelop/juiced/`;
submitted prompts, responses, and conversation state stay in the remote
workspace.

Use `juiced claude --new [Claude arguments...]` to replace the current tab's
binding. Supplying Claude arguments, such as `--model sonnet` or an initial
prompt, also starts a fresh bound session so those arguments take effect; a plain
`juiced claude` reconnects. A leading Juiced `--session ID` after `claude`,
Claude session-selection flags after it (such as `--resume`, `--continue`, or
`--session-id`), and `--no-session-persistence` bypass the terminal binding.
Pipes, print mode, help, and version commands also bypass it. If Juiced cannot
identify the terminal, it reports that automatic resume is unavailable and
starts normally; explicit session recovery remains available.

`juiced claude sessions` lists remote Juiced conversation IDs and their last
update times for the current project and workspace, including sessions from
other tabs and older sessions replaced with `--new`. It works with piped output,
without starting Claude, signing in, or syncing files. A missing workspace stays
uncreated. Git sessions are filtered by repository binding and launch directory.
Native passthrough sessions have no Juiced history and are excluded.

Interactive work continues when the laptop sleeps or loses connectivity. The TUI
retries transient connection failures until it reconnects or you exit, and
recovers missed output from the workspace journal. Drafts remain local while the
same TUI is open; unsubmitted drafts are not saved across CLI restarts.
Responses, submitted prompts, and pending permission requests can be
reconstructed after reopening the CLI.

A Claude process exits after two minutes idle; the next prompt or menu request
resumes its saved native conversation. Each process has a 24-hour execution
limit. If a sandbox disappears during a turn, Juiced restores saved output and
reports the interruption without automatically resubmitting that turn. Session
journals remain in the workspace until it is deleted. See
[session recovery](session-recovery.md) for the protocol details.

## Workspaces

The current directory selects a persistent workspace automatically. The slug is
its folder name plus a stable hash of its resolved absolute path, so two projects
with the same folder name remain separate. Select another workspace with an
option **before** the command:

```sh
juiced --workspace my-project claude login
juiced --workspace my-project claude
# Or choose a default for this shell:
export JUICED_WORKSPACE=my-project
```

Workspaces share neither files nor Claude login. Claude's HOME and account state
live at `/workspace`, including `.claude` and `.local`, and Claude starts in
`/workspace/<folder-name>`.

## Moving code

File sync is off by default.

For a Git repository, the first launch initializes a checkout from local `HEAD`;
later launches reuse the remote checkout. Use `juiced claude sync --to-workspace`
to send subsequent commits, or add `--include-uncommitted` to send local edits.
Import remote commits explicitly with `juiced claude sync --from-workspace` and
optionally apply them with `juiced claude fast-forward`. See
[Git workspaces](git-workspaces.md).

Non-Git directories start in a persistent remote project folder that is created
empty on first use. Normal Claude launches do not upload, download, or reconcile
files. To sync a non-Git folder explicitly:

```sh
# Reconcile files in both directions once, then exit:
juiced claude sync --files
# Or keep syncing in a separate terminal until Ctrl+C:
juiced claude sync --files --watch
```

Both commands use the selected workspace and its matching project folder and do
not start Claude or require Claude sign-in. File sync runs on macOS and Linux
(arm64 and x64). `.git`, `.cantelop`, `.env*`, `node_modules`, `dist`, and
`coverage` are excluded. Sync is bidirectional, including deletions after the
first reconciliation. Conflicting edits preserve both copies and stop the
command. Watch mode stops after 30 seconds offline; one local directory can have
one active sync command.

### From a conversation

Interactive Git sessions include the `juiced-local` MCP server, so you can ask
Claude to move code directly:

- **Publish its commits to your local checkout**, or **bring its file edits back
  as uncommitted changes** (`publish_commits`, `publish_snapshot`). Juiced shows
  the pinned commit or snapshot, a path preview, and Claude's summary in a local
  confirmation with **Deny** selected. Commit publication fast-forwards a clean
  local source branch. Snapshot publication preserves local staging and unrelated
  edits, and refuses overlapping edits or a changed baseline. Offers expire after
  five minutes.
- **Pull my latest laptop changes into this workspace** (`pull_local_changes`).
  Juiced captures a fixed local snapshot of commits and uncommitted edits and
  shows its commit, changed paths, and size for approval, with **No** selected.
  Nothing leaves your laptop before approval. The remote checkout must be clean,
  its HEAD must be an ancestor of the laptop's HEAD, and no other Claude session
  may use it.
- **Use my local `.env` and `test/data`** (`pull_local_files`). Juiced pins
  only the selected files, including hidden and ignored files, for laptop
  approval. It preserves their project-relative paths under an optional
  destination, leaves Git HEAD and staging unchanged, and refuses differing
  existing files. **List my local files, including hidden files**
  (`list_local_files`) shares directory names, types and sizes after approval.

Keep the local TUI connected to review requests. See
[local publication](local-publication.md) for the full workflow.

## GitHub access

```sh
juiced claude github-configure
```

Juiced uses `GH_TOKEN` from your shell or an existing local `gh` credential for
github.com. If neither is available, it opens GitHub's token creation page and
asks you to paste the token with input hidden. Choose the repository owner and
repositories; grant **Contents: Read and write** for pushing and **Pull requests:
Read and write** for opening PRs. Add **Workflows: Write** if the agent should
edit workflow files. See
[GitHub's token documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

To supply or rotate a specific token instead of reusing an existing credential,
pipe it explicitly (on macOS, after copying it):

```sh
pbpaste | juiced claude github-configure --stdin
```

The token is stored as an app secret and supplied to Claude as `GH_TOKEN`, with
`gh` as Git's HTTPS credential helper. Scope it to the intended repositories and
permissions; normal branch protection still applies. New remote processes
receive the updated token. To pick it up in an **existing conversation**, use
`/exit` if Claude is still running, then run `juiced claude` from the same tab,
or `juiced claude --session ID` from another. `/detach` leaves the existing
process running with its previous credentials.

Git workspaces copy remote URLs and source-branch tracking settings separately
from repository contents. GitHub SSH URLs become HTTPS URLs for token access.
Close active sessions before changing managed remote settings.

## Inspect a workspace

```sh
juiced claude ls
juiced claude peek
juiced claude peek --changes-only
juiced claude peek src/
```

`ls` lists the immediate remote entries. `peek` compares immediate local and
remote entries side by side; `--changes-only` hides the matches. A directory row
summarizes its descendants, so you drill down one level at a time by passing a
path. Neither command synchronizes files, changes the real index, starts Claude,
or needs Claude sign-in. Ignored untracked files are excluded; `--include-ignored`
requires an explicit path. A completed view exits 0 even when it shows
differences, while incomplete or excluded comparisons exit 2. See
[workspace inspection](workspace-inspection.md).

## Delete a workspace

```sh
juiced claude delete
juiced --workspace my-project claude delete
# Explicit confirmation for scripts:
juiced claude delete --yes
```

Deletion removes the entire remote workspace: its sessions, all project folders,
remote Git history, uncommitted edits, Claude login, and database data. It prints
the slug and canonical workspace ID, then asks you to type the slug; scripts must
pass `--yes`. An absent workspace is a no-op. Local files, branches, and
previously imported Git refs are kept, so import any remote commits you want to
keep before deleting. A later launch creates a fresh workspace and requires
Claude sign-in again.

## Local interface

- **Enter** submits the complete prompt when Claude is ready.
- **Alt+Enter**, **Shift+Enter** in terminals that support it, or **`\` then
  Enter** inserts a newline. Multiline paste stays in the editor until you submit.
- Arrow keys, Home/End, backspace/delete, Ctrl+A/E, Ctrl+U/K/W edit the local
  draft, including Unicode characters.
- **Esc** or **Ctrl+C** during a turn interrupts Claude. You can draft your next
  prompt while it works; Enter keeps that draft until the current turn finishes.
- **Ctrl+C** while idle clears the draft. With an empty draft, press **Ctrl+C**
  or **Ctrl+D** twice within a second to exit; **`/exit`** and **`/quit`** also
  disconnect and stop the remote process.
- **Esc** twice while idle clears the draft. **↑/↓** on the first or last line of
  the draft recall earlier prompts from this session.
- **Shift+Tab** cycles the permission mode through manual (default), accept
  edits, plan, and auto, plus bypass permissions when the session was launched in
  it. Use `/permissions` to save a default for the workspace. **`?`** in an empty
  prompt shows the keyboard shortcuts.
- **Ctrl+O** opens a detailed transcript with rendered Markdown and complete tool
  output. Scroll with **↑/↓** and **PgUp/PgDn**; **Esc** or **Ctrl+O** returns to
  the prompt with your draft intact.
- Tool approvals preselect **Yes**, as in Claude Code. When Claude suggests a
  rule, a **Yes, and don't ask again…** choice applies it with the scope Claude
  proposed. **Tab** on the request lets you decline with a message. Keys typed in
  the 300 ms after a dialog opens, and pasted text, never answer it. Applying
  remote changes to your local checkout defaults to **No**.
- **`/detach`** disconnects while remote work continues. Closing the terminal
  also detaches. Reattach with **`juiced claude`** in the same tab, or
  **`juiced claude --session ID`** from another tab in the same project and
  workspace.
- **`/`** previews available commands. Keep typing to filter, use **↑/↓** to
  select, **Tab** to complete before adding arguments, and **Enter** to run.
- **`/model`**, **`/effort`**, **`/output-style`**, **`/config`**,
  **`/permissions`**, and **`/mcp`** open local menus backed by the remote Claude
  session. **`/model <name>`** also accepts a full model ID. Confirmed changes are
  saved in `/workspace/.claude/settings.json` for future sessions in that
  workspace; explicit Claude flags override them for that invocation.
- **`/context`**, **`/usage`**, **`/memory`**, **`/hooks`**, **`/agents`**,
  **`/skills`**, **`/plugins`**, **`/tasks`**, and **`/status`** open local data
  views. **`/rename`** opens a name editor. Some views are read-only; see
  [menu coverage and limitations](local-command-menus.md).
- **`/help`** opens the command browser and local shortcuts, including the
  remote session's project skills and custom commands. Native-only screens such
  as **`/resume`** and **`/rewind`** explain their availability locally.
