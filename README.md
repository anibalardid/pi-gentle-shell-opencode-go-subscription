# pi-gentle-shell-opencode-go-subscription

Your **OpenCode Go** subscription usage — rolling 5-hour, weekly and monthly
windows — inside Gentle Shell's sidebar **Status** card, under
**Integrations**, with a `/opencode-go` panel to turn it on or off.

```
╭─ Status ──────────────────────╮
│ Project                       │
│   ~/work/app  main            │
│ Changes                       │
│   2 files · +12 −3            │
│ Integrations                  │
│   Go 5h 62% · wk 31% · mo 44% │
╰───────────────────────────────╯
```

- Refreshes on a timer (5 minutes by default) and on demand
- `/opencode-go` toggles the line, changes the cadence and edits the key
- Reuses the key `/login` already stored — usually zero configuration
- Works in Pi too; the same `setStatus` line shows in Pi's footer

## Quick start

```sh
git clone git@github.com:anibalardid/pi-gentle-shell-opencode-go-subscription.git
cd pi-gentle-shell-opencode-go-subscription

# Gentle Shell runs an isolated Pi home: tell the installer where it is
PI_CODING_AGENT_DIR="$HOME/.gentle-shell/agent" node scripts/install.mjs

# restart Gentle Shell, then:
/opencode-go
```

No `npm install` — the extension has no dependencies.

## Requirements

- **Pi** (`@earendil-works/pi-coding-agent`, 1.5 or newer) or **Gentle Shell**
  (`gentle-shell`, which runs Pi with an isolated home).
- **Node.js 22.6+** only for the installer, the tests and the diagnostic
  script. The extension itself runs inside Pi's runtime.
- An OpenCode Go subscription, and one of: a Pi `/login` session with the
  `opencode-go` provider, an OpenCode CLI login, an API key, or a console
  session cookie.

## Install

Pi discovers extensions in `<agent-dir>/extensions/`, where `<agent-dir>` is:

| Runtime | Agent dir |
| --- | --- |
| Pi | `~/.pi/agent` |
| Gentle Shell | `~/.gentle-shell/agent` (isolated home) |

Three ways to install. A and B end with a symlink, so edits and `git pull`
apply without reinstalling; C copies the files, which keeps Pi away from your
checkout at the cost of a re-copy after each change.

### Option A — installer (recommended)

The repository ships a tiny installer that creates the link for you:

```sh
git clone git@github.com:anibalardid/pi-gentle-shell-opencode-go-subscription.git
cd pi-gentle-shell-opencode-go-subscription

# Pi
node scripts/install.mjs

# Gentle Shell
PI_CODING_AGENT_DIR="$HOME/.gentle-shell/agent" node scripts/install.mjs
```

It prints the resulting link and where the config file will live:

```
pi-gentle-shell-opencode-go-subscription → /Users/<you>/.gentle-shell/agent/extensions/pi-gentle-shell-opencode-go-subscription
config file: /Users/<you>/.gentle-shell/agent/opencode-go.json
```

`GENTLE_PI_AGENT_HOME` is honoured too, and wins over `PI_CODING_AGENT_DIR`.

### Option B — symlink by hand

```sh
git clone git@github.com:anibalardid/pi-gentle-shell-opencode-go-subscription.git

# Pi
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-gentle-shell-opencode-go-subscription" ~/.pi/agent/extensions/pi-gentle-shell-opencode-go-subscription

# Gentle Shell
mkdir -p ~/.gentle-shell/agent/extensions
ln -s "$PWD/pi-gentle-shell-opencode-go-subscription" ~/.gentle-shell/agent/extensions/pi-gentle-shell-opencode-go-subscription
```

The link name is free-form; only the directory's `index.ts` (or the
`pi.extensions` entry in `package.json`) matters.

### Option C — copy instead of link

If you would rather not have Pi load code from your checkout:

```sh
mkdir -p ~/.gentle-shell/agent/extensions/pi-gentle-shell-opencode-go-subscription
cp index.ts go-usage-core.ts go-usage-fetch.ts package.json \
   ~/.gentle-shell/agent/extensions/pi-gentle-shell-opencode-go-subscription/
```

Re-copy after every change — a symlink avoids that step.

### Verify the install

```sh
# loads through Pi's real extension loader and prints what registered
node scripts/smoke.mjs
# → commands: opencode-go

# or ask the running shell
/opencode-go
```

Restart Gentle Shell or run `/reload`. The line appears in the **Status** card
of the right sidebar, in the **Integrations** group.

If the card is hidden, check `/gentle:customize` → **Sections** → Status: that
is a Gentle Shell setting, and an extension cannot force it back on.

### Uninstall

```sh
rm ~/.gentle-shell/agent/extensions/pi-gentle-shell-opencode-go-subscription
rm ~/.gentle-shell/agent/opencode-go.json   # optional: the saved config
```

## Credentials

Resolved in this order, first match wins:

1. **Environment** — `OPENCODE_GO_API_KEY`, then `OPENCODE_API_KEY`, then
   `OPENCODE_ZEN_API_KEY`.
2. **This extension's config** — `<agent-dir>/opencode-go.json`, field `apiKey`.
3. **Pi's own credential store** — `<agent-dir>/auth.json`, written by
   `/login`: the `opencode-go` entry, then `opencode`. This is the same key the
   models use, so logging in once is enough; the panel then reads
   *api key · pi login (opencode-go)*.
4. **OpenCode's CLI credential store** — `~/.local/share/opencode/auth.json`,
   same entry order. Useful when Pi and the OpenCode CLI share a machine but not
   a login.
5. **Console cookie + workspace** — environment
   (`OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`), then the config
   file, then the file the OpenCode Go usage plugin writes:
   `~/.config/opencode/opencode-quota/opencode-go.json`.

`XDG_DATA_HOME` and `XDG_CONFIG_HOME` are honoured, and `OPENCODE_GO_ORIGIN`
overrides the base URL (useful against a mock). Nothing is ever read from this
repository.

### The config file

`<agent-dir>/opencode-go.json` — `~/.pi/agent/opencode-go.json` for Pi,
`~/.gentle-shell/agent/opencode-go.json` for Gentle Shell. It is written with
mode `0600` because it may hold a key or a cookie.

```json
{
  "version": 1,
  "enabled": true,
  "compact": true,
  "refreshSeconds": 300
}
```

Add `apiKey`, `workspaceId` or `authCookie` only when you want to pin
credentials here instead of using the sources above.

### Expired keys

The service names the problem, and the extension repeats it verbatim:

```json
{ "error": { "type": "authentication_error", "code": "api_key_expired",
             "message": "This API key has expired. ..." } }
```

becomes

```
Go: API key expired · /opencode-go
```

Mint a new key in the OpenCode Console, run `/login` again (or
`opencode auth login`), and the next refresh picks it up. To pin it by hand,
use the panel's **set api key** row.

## Usage

```
/opencode-go              open the panel
/opencode-go on|off       toggle the sidebar line
/opencode-go refresh      fetch now and print the line
/opencode-go reset        recreate the config file with defaults
```

The panel:

```
✿ OpenCode Go
  enabled       on
  compact       on
  refresh       300s
  refresh now   Enter
  auth          api key · pi login (opencode-go)
  set api key   Enter
  updated       14:32:05
  status        Go 5h 62% (1h 12m) · wk 31% (2d 7h) · mo 44%
```

- **enabled** — publish or clear the sidebar line
- **compact** — percentages only, or with reset countdowns
- **refresh** — cycle 60 / 120 / 300 / 600 seconds
- **set api key** — closes the panel, opens a dialog, saves with mode `0600`,
  then refreshes. Submitting an empty value clears the saved key so the
  previous source (environment or `/login`) applies again.
- **auth**, **updated**, **status** — read-only, for troubleshooting

Turning it off clears the status line instead of leaving a stale number.

## How it works

Gentle Shell renders every extension status published with
`ctx.ui.setStatus(key, text)` inside the Status card's **Integrations** group,
sorted by key. This extension publishes one key, `opencode-go`, and clears it
with `undefined` when disabled.

The numbers come from one of two endpoints:

| Source | Endpoint | Credential |
| --- | --- | --- |
| **API key** (preferred) | `GET /zen/go/v1/usage` | `Authorization: Bearer <key>` |
| Console session | `GET /console/api/go/status` | `__Host-console_session` cookie + `x-org-id` |

The API-key endpoint returns percentages directly:

```json
{ "usage": {
    "rolling": { "status": "ok", "percent": 1,  "resetsAt": "2026-09-30T17:15:45.084Z" },
    "weekly":  { "status": "ok", "percent": 25, "resetsAt": "2026-10-05T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 29, "resetsAt": "2026-10-21T07:45:46.000Z" } } }
```

The console endpoint returns micro-cents (`usedMicroCents` / `limitMicroCents`,
100,000,000 per USD) and needs a workspace id; the monthly window falls back to
`access.endsAt` for its reset. Both payloads are parsed by the same code, and
neither is guessed: a payload with no meters is reported as an unexpected
response, never as `0%`.

Refresh runs on a timer, on `/opencode-go refresh`, and after a key change. A
failed refresh keeps the last good numbers on screen instead of blanking them.

## Troubleshooting

| Status line | Meaning |
| --- | --- |
| `Go: not connected · /opencode-go` | No key and no cookie found — see Credentials |
| `Go: API key expired · /opencode-go` | The service rejected the key; mint a new one |
| `Go: auth 401` / `auth 403` | Same, on the console cookie path |
| `Go: unexpected response · /opencode-go` | The payload no longer carries meters; the parser needs an update |
| `Go: timeout` / `network error` | Transient, or `opencode.ai` unreachable |
| Line never appears | Extension not discovered, status card hidden, or `/opencode-go` says off |

`npm run check` resolves the credentials the extension would use and prints the
exact line it would publish:

```sh
PI_CODING_AGENT_DIR="$HOME/.gentle-shell/agent" npm run check
# auth: api · pi login (opencode-go)
# shape: api
# status: Go 5h 0% · wk 9% · mo 7%
# detail: Go 5h 0% (5h 0m) · wk 9% (6d 0h) · mo 7% (6d 23h)
```

It never prints the key or the cookie, only where it came from.

## Develop

```sh
npm test                 # 21 unit tests over the pure core
npm run smoke            # load through Pi's real extension loader
npm run check            # live: resolve credentials, fetch, format
```

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi surface: timer, `setStatus`, the `/opencode-go` panel |
| `go-usage-core.ts` | Pure: config format, credential order, both payload shapes, formatting |
| `go-usage-fetch.ts` | The two transports; no Pi imports, shared with the check script |
| `test/go-usage-core.test.ts` | Unit tests for the pure core |
| `scripts/install.mjs` | Symlink into an agent dir |
| `scripts/smoke.mjs` | Loader smoke test |
| `scripts/check.ts` | Live diagnostic against the real service |

The split is deliberate: everything decidable is pure and tested, the network
path is shared verbatim between the extension and the diagnostic, and `index.ts`
only wires Pi's lifecycle to them.

## License

MIT
