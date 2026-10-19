# Local Claude command menus

Juiced renders menus locally while the Claude process and its workspace remain
on Cantelop. The renderer handles selection, filtering, nested pages, text input,
resize, cancel, errors, and pending confirmations. Typing and back navigation do
not send network requests. Opening a remote data view fetches a snapshot;
confirming a change sends a control request to the existing Claude process.
Model, effort, output style, fast mode, and permission mode changes apply to the
running session after Claude acknowledges them, then save to the remote workspace’s
`/workspace/.claude/settings.json`. New sessions load these defaults through
Claude’s native settings resolution; command-line flags override them for one
invocation. The defaults follow the workspace across clients and stay outside
project sync and Git transfers. Other settings and permission rules are preserved.
A failed save is reported explicitly; the running session retains its applied
choice. Individual tool approvals remain one-time grants. Settings changes do not
submit user prompts or spend model turns.

Catalogs come from Claude: models and their effort levels, output styles,
commands and aliases, agents, MCP servers, loaded memory files, and context
categories. Juiced defines command adapters and protocol actions, including its
permission mode choices; it does not maintain a separate model catalog.

## Coverage on Claude Code 2.1.259

| Command | Local behavior | Limitations |
| --- | --- | --- |
| `/model [name]` | Provider catalog, current selection, switch after acknowledgment | Direct names accept full model IDs |
| `/effort [level]` | Levels advertised for the current model | Saved workspace default; no fabricated fallback levels |
| `/output-style [name]` | Styles advertised by the remote workspace | Saved workspace default; restart to discover new styles |
| `/config`, `/settings` | Model, effort, style, fast mode, permissions, effective settings and sources | Credentials redacted; supported `key=value` entries open the relevant picker; other settings are read-only |
| `/fast [on\|off]` | Current state, availability reason, confirmed change | Disabled when Claude reports an account, model, or SDK restriction |
| `/permissions` | Mode selector, explicit confirmation, allow/ask/deny rule browser | Rule editing, auto-mode setup, and bypass mode are not exposed |
| `/mcp` | Server list, details and tools, reconnect, confirmed enable/disable | Native OAuth and server creation dialogs are not exposed |
| `/context` | Categories, token estimates, summary details | Uses summary mode; no token-count API requests |
| `/usage`, `/cost`, `/stats` | Structured plan/session usage where supported; cost summary fallback | Older versions may provide session cost only |
| `/memory` | Loaded files, permission-checked reading | Read-only; up to 32 KiB per file |
| `/hooks` | Native listing when available; source settings fallback | Pinned version has no hook editor or complete plugin-hook listing API |
| `/agents` | Remote agent definitions and descriptions | Read-only; manage definitions in `.claude/agents/` |
| `/skills` | Remote command browser; choosing inserts an editable draft | Does not execute a skill without submitting its draft |
| `/plugin`, `/plugins` | Loaded/configured plugin list and confirmed reload | Installation, removal, and marketplace management require native CLI |
| `/tasks` | Reported task state, details, output where supported, confirmed stop | Output RPC is version-dependent; refresh explicitly to update the view |
| `/rename`, `/name` | Local name editor, remote acknowledgment | Current conversation only |
| `/reload-skills`, `/reload-plugins` | Confirm, reload, refresh catalogs | Remote errors stay in the menu and allow retry |
| `/status` | Session status and public metadata | No account credentials |
| `/help` | Command browser and keyboard shortcuts | Juiced keyboard shortcuts apply to its local editor |

This is an adapter layer, not complete native UI parity. Claude's headless API
does not supply a universal menu schema. `/resume`, `/rewind`, `/checkpoint`,
`/theme`, `/terminal-setup`, `/keybindings`, `/vim`, `/login`, `/logout`,
`/add-dir`, `/export`, `/feedback`, `/bug`, and `/remote-control` are intercepted
with a local explanation. They are never silently forwarded as LLM prompts.
Project skills and other commands advertised by Claude retain normal prompt
submission semantics.

## Verification and extensions

`test/command-menus.test.ts` covers provider catalogs, aliases, local navigation,
paste safety, confirmation, rejected changes, cancellation during a slow read,
redaction, and resize bounds. `test/agent.test.ts` verifies ordered control
requests, acknowledgment, capability fallback, and task events.

For a real binary check without Cantelop or a model call:

```sh
node --import tsx scripts/test-menus-local.mjs /path/to/claude
```

The script uses a fresh temporary configuration and directory, reads menu data,
checks settings across fresh processes, rejects any attempted user frame, and
removes its temporary files. It does not verify hosted latency, subscription entitlements,
MCP OAuth, or native-only screens.

Add new commands in `src/tui/command-menus.ts` using `MenuPage`/`MenuItem`; add
typed query or mutation requests in `src/remote-agent.ts` when needed. A read
must preserve the current agent status. Mutations must wait for acknowledgment
and preserve existing metadata on failure. Never infer missing choices from a
local CLI version, automatically retry a mutation, or treat an unknown response
as a successful configuration change.
