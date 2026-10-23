# Juiced

<img src="docs/assets/juiced-mascot.svg" width="240" alt="The Claude mascot drinks a glass of juice through a straw and turns green">

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

- **A session in every tab** — each terminal tab gets its own Claude session.
  Open another tab and run `juiced claude` to work on something else in
  parallel, with as many sessions going at once as you need.
- **Persistent sessions** — detach with `/detach` or just close the terminal;
  work continues remotely. Run `juiced claude` again in the same tab to pick up
  where you left off.
- **One workspace per project** — your current directory picks the workspace, so
  each project keeps its own files, Claude login, and conversations.
- **Explicit code transfer** — Git repositories start from your local `HEAD`.
  After that, nothing moves between your laptop and the cloud unless you ask.
- **Native Claude Code** — the stock Claude Code CLI with your own Claude
  account, including its permission checks, models, skills, and MCP servers.
- **GitHub access** — give the workspace a scoped token so Claude can push
  branches and open pull requests.

## Requirements

- macOS 13.5+ or Linux with glibc 2.28+, on Apple Silicon, x64, or Linux arm64
- Git, for working with Git repositories
- A Claude account with Claude Code access (Juiced does not include model usage)
- A [Juiced account](https://juiced.codes/pricing), or your own
  [self-managed deployment](docs/self-managed.md)

## Install

```sh
curl -fsSL https://juiced.codes/install.sh | sh
```

The installer downloads a [release](https://github.com/stepandel/juiced/releases)
with Node.js and all dependencies bundled, so you don't need Node.js or npm. It
verifies checksums and installs without `sudo` into `~/.local/share/juiced`, with
the `juiced` command in `~/.local/bin`. Add `~/.local/bin` to your `PATH` if
prompted; shell startup files are left unchanged.

Rerun the command to update, or pin a version:

```sh
curl -fsSL https://juiced.codes/install.sh | sh -s -- 0.2.0
```

`JUICED_INSTALL_DIR` and `JUICED_BIN_DIR` choose other absolute install and
command directories; set them on `sh` when piping. See
[CLI releases](docs/cli-releases.md) for removal and other details.

The managed CLI reports basic install and usage events when analytics is enabled
on the service. It never sends prompts, source code, terminal output, or command
arguments to analytics. Run `juiced telemetry disable` to opt out, or set
`JUICED_TELEMETRY_DISABLED=1` on the installer and CLI. See [telemetry](docs/telemetry.md).

> The unrelated `juiced` package on the npm registry is not this project. Don't
> install it.

### From source

With Node.js 22 or later:

```sh
git clone https://github.com/stepandel/juiced.git
cd juiced
npm install
npm run build
npm link
```

## Quick start

```sh
juiced login            # sign in to your Juiced account (GitHub or Google)
cd your-project
juiced claude login     # sign in to Claude for this project's workspace
juiced claude           # start working
```

Your Juiced sign-in is shared across terminal windows on this computer. Running
`juiced login` again reuses it. Run `juiced logout` to sign out on this computer,
or `juiced logout --all` to sign out all CLI sessions. To switch accounts, sign
out first, then run `juiced login` again.

When Claude is done, review and bring back its work:

```sh
juiced claude peek --changes-only      # compare local and remote files
juiced claude sync --from-workspace    # import Claude's commits
juiced claude fast-forward             # apply them to your branch
```

During an interactive Git session, you can also ask Claude to **use my local
`.env` and the fixtures in `test/data`**. Juiced previews and requests approval
for those files on your laptop, including hidden and ignored files. See
[selective local file access](docs/local-publication.md#select-laptop-files-including-hidden-and-ignored-files).

## Common commands

| Command | What it does |
| --- | --- |
| `juiced logout` | Sign out of Juiced across terminal windows on this computer |
| `juiced logout --all` | Sign out all Juiced CLI sessions |
| `juiced claude` | Start or reconnect to this tab's session (open more tabs for more sessions) |
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
architecture overview, and [CLI releases](docs/cli-releases.md) for packaging and
publishing.

## License

[MIT](LICENSE)
