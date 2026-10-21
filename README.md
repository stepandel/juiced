# Juiced

Run Claude Code in a persistent cloud workspace, driven from your own terminal.

```sh
juiced claude
```

Juiced opens a local terminal UI connected to a real Claude Code process running
in the cloud. Typing and editing stay instant on your machine, while Claude's
agent loop, tools, files, and login live in a workspace that keeps going when you
close your laptop. Reconnect from the same terminal tab, or from another machine,
and pick up where you left off.

[Documentation](https://juiced.codes/docs) · [Pricing](https://juiced.codes/pricing) · [juiced.codes](https://juiced.codes)

## Features

- **Persistent sessions** — detach with `/detach` or just close the terminal;
  work continues remotely. Run `juiced claude` again to reconnect.
- **One workspace per project** — your current directory picks the workspace, so
  each project keeps its own files, Claude login, and conversations.
- **Explicit code transfer** — Git repositories start from your local `HEAD`.
  After that, nothing moves between your laptop and the cloud unless you ask.
- **Native Claude Code** — the stock Claude Code CLI with your own Claude
  account, including its permission checks, models, skills, and MCP servers.
- **GitHub access** — give the workspace a scoped token so Claude can push
  branches and open pull requests.

## Requirements

- Node.js 22 or later
- Git, for working with Git repositories
- A Claude account with Claude Code access (Juiced does not include model usage)
- A [Juiced account](https://juiced.codes/pricing), or your own
  [self-managed deployment](docs/self-managed.md)

## Install

The CLI is not yet published to npm. Build it from source:

```sh
git clone https://github.com/stepandel/juiced.git
cd juiced
npm install
npm run build
npm link
```

> The unrelated `juiced` package on the npm registry is not this project. Don't
> install it.

## Quick start

```sh
juiced login            # sign in to your Juiced account (GitHub or Google)
cd your-project
juiced claude login     # sign in to Claude for this project's workspace
juiced claude           # start working
```

When Claude is done, review and bring back its work:

```sh
juiced claude peek --changes-only      # compare local and remote files
juiced claude sync --from-workspace    # import Claude's commits
juiced claude fast-forward             # apply them to your branch
```

## Common commands

| Command | What it does |
| --- | --- |
| `juiced claude` | Start or reconnect to this tab's session |
| `juiced claude --new` | Start a fresh session |
| `juiced claude sessions` | List saved conversations |
| `juiced claude --session <id>` | Reopen a specific conversation |
| `juiced claude sync --to-workspace` | Send new local commits (add `--include-uncommitted` for edits) |
| `juiced claude sync --from-workspace` | Import remote commits |
| `juiced claude sync --files [--watch]` | Sync a non-Git folder |
| `juiced claude ls` / `peek` | Inspect the remote workspace |
| `juiced claude github-configure` | Give Claude a GitHub token |
| `juiced claude delete` | Delete this project's remote workspace |
| `juiced claude -p "…"` | Run a one-off prompt with native output |

## Documentation

- [Getting started](https://juiced.codes/docs/getting-started) and the other
  [online guides](https://juiced.codes/docs)
- [Using Juiced](docs/usage.md) — sessions, workspaces, code transfer, GitHub,
  and keyboard shortcuts
- [Git workspaces](docs/git-workspaces.md) and
  [local publication](docs/local-publication.md)
- [Session recovery](docs/session-recovery.md)
- [Self-managed deployment](docs/self-managed.md)

## Contributing

See [development](docs/development.md) for building, testing, and the
architecture overview.

## License

[MIT](LICENSE)
