# codex-from-chatgpt

**Use ChatGPT as the architect and orchestrator, while your local Codex does the
actual work on your machine.**

A personal, single-user MCP bridge. ChatGPT sends an instruction, the local
service turns it into a `codex app-server --stdio` thread, and returns a compact
summary of what Codex did.

## Why

Codex is already good at doing the work. What it does not have is someone to
decide *what* work to do, review the result, and push back. That is the part
you normally do by hand, one prompt at a time.

This bridge puts ChatGPT in that seat. It plans, delegates, reads the diff, and
sends the next instruction — while every command and file change happens on
your machine, in your real repository, under approvals you control.

```text
You: "Investigate this bug and fix it."

ChatGPT
  → starts a local Codex job
  → reviews the result
  → asks Codex for a correction
  → starts an independent review
  → handles approvals with you

Codex works on your actual local repo.
```

> **Dogfooded:** v0.3 was developed using v0.2 — ChatGPT orchestrated local
> Codex implementation and independent review through this MCP. See
> [Built using itself](#built-using-itself).

> **Community project, not official:** this is not an official OpenAI or
> ChatGPT integration.

## Architecture

The product boundary is deliberately small:

```text
ChatGPT (through a Secure MCP Tunnel)
  -> MCP Streamable HTTP (/mcp)
  -> compact job API
  -> codex app-server --stdio (JSONL)
  -> local Codex
```

It does not use `codex mcp-server`, does not expose shell or filesystem as MCP
tools, and implements no broker, worker farm, or external storage.

It also does not implement its own multi-agent framework — and does not need
one. ChatGPT can orchestrate multiple independent Codex jobs through the same
five-tool API: one job implements, another reviews it, and ChatGPT arbitrates
between them.

## Built using itself

`codex-from-chatgpt` was built and validated through the same loop it exposes:
ChatGPT coordinated tasks over MCP, the bridge created local Codex threads, and
the app-server returned snapshots to review the result. That loop was used for
the implementation, follow-ups, independent reviews, and for answering Codex
approvals.

The same loop maintains it. Using the [five tools](#mcp-tools) described below:

1. Use `codex_start` to investigate a change and its risks.
2. Use `codex_continue` to implement or fix one concrete part.
3. Use `codex_get` to review the standard handoff; request `debug` only when
   the bounded command log or diff is needed.
4. Use `codex_respond_approval` to answer specific approvals via their exact
   `request_id`.
5. Run independent reviews, then `npm run typecheck`, `npm test`, and
   `git diff --check` before calling a change done.

The idea is that the bridge is both the development tool and the artifact that
documents how it is used.

## Requirements

- Node.js 20 or later.
- Codex CLI on your `PATH`, installed and authenticated locally. Tested against
  **Codex CLI 0.147.0** (app-server v2); other versions may work, and the
  installed binary is always the authority — see
  [Protocol compatibility](#protocol-compatibility).
- A workspace directory, or a symlink entry for one, whose supplied path is
  under the allowed administrative root. That root defaults to `~/workspace`
  and must exist:

  ```bash
  mkdir -p ~/workspace
  ```

- An OpenAI Platform account that can create tunnels, and a ChatGPT workspace
  where you can enable developer mode (see [Plan availability](#plan-availability)).

Check your local Codex before wiring anything up:

```bash
codex --version
```

## Setup overview

The full path from a clean clone to a working Codex job:

```text
clone -> install -> configure -> run locally
      -> install tunnel-client -> configure tunnel -> doctor -> run tunnel
      -> connect in ChatGPT -> verify tools -> first Codex job
```

Each step below corresponds to one stage of that sequence.

## 1. Clone, install, run locally

```bash
git clone https://github.com/joseanu/codex-from-chatgpt.git
cd codex-from-chatgpt
npm install
npm run build
npm start
```

The process listens on loopback only by default:

- MCP: `http://127.0.0.1:8787/mcp`
- health: `http://127.0.0.1:8787/healthz`
- readiness: `http://127.0.0.1:8787/readyz`

## 2. Verify the local service

In a second terminal, confirm both the service and the Codex app-server are up.
`/readyz` returns `503` until the app-server has initialized:

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

To use a different administrative root or port:

```bash
CODEX_WORKSPACE_ROOT=/absolute/path/to/workspaces PORT=8787 npm start
```

Leave this process running. Everything below assumes it is up.

## 3. Install tunnel-client

ChatGPT does not connect directly to `127.0.0.1`. OpenAI's supported path for a
local MCP server is the **Secure MCP Tunnel**, run by
[`tunnel-client`](https://github.com/openai/tunnel-client) — a customer-run
agent that bridges a private or localhost MCP server to ChatGPT and Codex over
long-polling HTTPS, keeping the server off the public internet.

```text
ChatGPT
  -> OpenAI control plane
  -> tunnel-client (on your machine)
  -> http://127.0.0.1:8787/mcp
  -> codex-from-chatgpt
  -> codex app-server --stdio
```

Get the binary from the OpenAI Platform under **Tunnels**, or from the
[release archives](https://github.com/openai/tunnel-client/releases). Docker
images are published at `ghcr.io/openai/tunnel-client`. To build from source:

```bash
go build -o bin/tunnel-client ./cmd/client
```

OpenAI recommends starting with the built-in guide:

```bash
tunnel-client help quickstart
```

### Credentials, and where each one comes from

| Credential | Env var | Used for | Where to create it |
| --- | --- | --- | --- |
| Tunnel ID | `CONTROL_PLANE_TUNNEL_ID` | Identifies your tunnel. Format: `tunnel_` + 32 hex chars. | Platform → [Tunnels](https://platform.openai.com/settings/organization/tunnels), or `tunnel-client admin tunnels create` |
| Runtime API key | `CONTROL_PLANE_API_KEY` | The credential the daemon and `doctor` actually use. | Platform → [API keys](https://platform.openai.com/settings/organization/api-keys) |
| Admin API key | `OPENAI_ADMIN_KEY` | Only for `tunnel-client admin tunnels` CRUD. | Platform → [Admin keys](https://platform.openai.com/settings/organization/admin-keys) |

Do **not** use the admin key as the daemon credential — OpenAI's docs call this
out explicitly. `CONTROL_PLANE_API_KEY` is the preferred variable;
`OPENAI_API_KEY` is only a fallback when it is unset.

## 4. Configure the tunnel

Export the two runtime values:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
export CONTROL_PLANE_TUNNEL_ID="tunnel_0123456789abcdef0123456789abcdef"
```

This project is an HTTP MCP server that is already running, so initialize from
the remote-HTTP sample and bind the `main` channel to its local URL:

```bash
tunnel-client init --sample sample_mcp_remote_no_auth \
  --profile codex-from-chatgpt \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-server-url http://127.0.0.1:8787/mcp
```

The resulting profile is YAML, and the `main` channel is required:

```yaml
config_version: 1
control_plane:
  tunnel_id: tunnel_0123456789abcdef0123456789abcdef
  api_key: env:CONTROL_PLANE_API_KEY
  base_url: https://api.openai.com
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:8787/mcp
```

Profiles are discovered under `$XDG_CONFIG_HOME/tunnel-client` or
`~/.config/tunnel-client`; a single config file can also be passed with
`--config` or `TUNNEL_CLIENT_CONFIG`.

## 5. Doctor, then run the tunnel

Validate before starting the daemon:

```bash
tunnel-client doctor --profile codex-from-chatgpt --explain
```

Then run it in the foreground, in its own terminal:

```bash
tunnel-client run --profile codex-from-chatgpt
```

> **Host header:** `/mcp` validates the `Host` header against the configured
> `HOST:PORT` and rejects anything else with `403` (see
> [Security and limits](#security-and-limits)). If your tunnel forwards its own
> hostname instead of the loopback upstream, add it with
> `CODEX_AGENT_ALLOWED_HOSTS` and restart this service.

## 6. Connect it in ChatGPT

Full MCP connectors live behind developer mode. An admin or owner enables it in
**Workspace Settings → Permissions & Roles → Connected Data → Developer mode /
Create custom MCP connectors**. Then create the custom MCP app pointing at your
tunnel, let ChatGPT scan the tools, and enable it for your chats. Do not enter a
`127.0.0.1` URL in ChatGPT — it cannot reach it.

### Plan availability

Full MCP support including **write actions** is in beta for ChatGPT
**Business, Enterprise, and Edu** on ChatGPT web. **Pro** users can build apps
with the Apps SDK and use custom apps in deep research, but for **read/fetch
actions only**.

This matters here: the five tools below are not read-only — they start Codex
turns that run commands and change files. On a plan limited to read/fetch, this
bridge will not work as intended. This project promises no universal support;
only the capabilities your connected ChatGPT environment exposes will be
available.

## 7. Verify the tools

After the scan, ChatGPT should list exactly five tools: `codex_start`,
`codex_get`, `codex_continue`, `codex_interrupt`, and `codex_respond_approval`.
If they are missing, re-check `tunnel-client doctor` and `/readyz` before
touching anything in ChatGPT.

## 8. First Codex job

Ask for something read-only first, with an absolute workspace path under the
allowed root:

```text
Use codex_start in the workspace "/Users/you/workspace/my-project"
to inspect the git status without modifying any files. Give me the job_id,
then check the result with codex_get.
```

The normal flow is:

1. `codex_start` creates the persistent thread and begins the first turn.
2. `codex_get` returns the revision-aware job snapshot (standard by default).
3. When a turn finishes, `codex_continue` sends the next instruction to the
   same thread.
4. If Codex asks for an approval, `codex_respond_approval` answers it using the
   exact `request_id` from `pending_approvals`.
5. `codex_interrupt` stops an active turn when needed.

## MCP tools

The public surface is exactly this:

| Tool | Schema | Semantics |
| --- | --- | --- |
| `codex_start` | `{ workspace: string, prompt: string }` | Validates the workspace, creates a persistent thread, starts a turn. |
| `codex_get` | `{ job_id: string, detail?: "compact" \| "standard" \| "debug", since_revision?: number }` | Returns a revision-aware job snapshot; `standard` is the default. |
| `codex_continue` | `{ job_id: string, prompt: string }` | Reuses the same thread and starts another turn once the previous one ended. |
| `codex_interrupt` | `{ job_id: string }` | Runs `turn/interrupt` on the active turn. |
| `codex_respond_approval` | `{ job_id: string, request_id: string \| number, decision: ... }` | Answers one specific app-server approval. |

`codex_get` has three deliberately different payload sizes:

- `compact` is for polling: status, revision, current activity, and critical
  errors or approvals.
- `standard` is the default supervisory handoff. While running it includes
  useful activity and changed files; after completion it includes the final
  message, files, deterministic diffstat, and recognized validation results,
  without the full command log or patch.
- `debug` includes bounded `commands_executed` and `latest_diff` fields for
  diagnosis. The underlying state remains available for recovery and is not
  discarded when standard hides it.

Pass `since_revision` from the previous response to suppress unchanged compact/
standard supervisory payloads; `debug` is always an on-demand current diagnostic
snapshot. An unchanged response is intentionally tiny (`status`, `revision`,
and `unchanged: true`), but pending approvals and errors are still surfaced.
The revision is persisted per job and tracks supervisory/control-plane state.
Debug-only command history and raw diff changes can update without advancing
it.

Recommended flow: save the revision from `codex_start`, poll with `compact` and
`since_revision`, then when the job completes call `codex_get` with
`detail: "standard"` and no cursor for the final handoff. The cursor means “I
know this supervisory state”, not “I have seen this detail view”, so a standard
request with the same revision may also be `unchanged`; unchanged responses omit
already-known warnings, while pending approvals and errors remain visible.

Every persistent thread also receives one short internal completion-handoff
requirement automatically. It asks Codex's final response to state actions,
files changed, validation and results, plus unresolved warnings or limitations;
the caller's original prompt remains intact, and the requirement is not
repeated on every continuation.

Approvals include their exact `request_id`, kind, and enough detail to choose a
decision even in compact or unchanged polling responses. `pending_approval`
remains an alias for the first approval, while `pending_approvals` carries all
currently pending approvals. The bridge never returns the raw JSONL stream.

Approvals accept only the values and objects defined by the installed protocol
for command execution, file changes, permissions, and legacy approvals.
`request_id` is mandatory: two approvals can be pending at once, and one is
never answered by position or by "the last one received".

## Lifecycle, persistence, and recovery

States are `starting`, `running`, `awaiting_approval`, `interrupting`,
`completed`, `interrupted`, `failed`, and `recovery_required`.

v0.3 allows a single active turn per process/app-server. A concurrent `start`
or `continue` returns a semantic backend-busy error; `interrupt` remains
available for the active turn. A process failure or a timeout with an uncertain
outcome leaves the job in `recovery_required` — never in an invented
`completed`.

The minimal `job_id → thread_id` index, workspace, last turn, and summary are
written atomically to a local file. Its location can be set with
`CODEX_AGENT_STATE_FILE`. Its contents may include final messages, diffs,
files, commands, and errors, so treat it as potentially sensitive.

On app-server initialization, persisted jobs are rehydrated via `thread/read`
and, where applicable, `thread/resume`. If the state cannot be proven, the job
stays in `recovery_required` rather than silently becoming `completed`.

## Security and limits

- The service binds to `127.0.0.1` by default.
- `/mcp` validates the `Host` header against the configured `HOST:PORT` and
  answers `403` to anything else. This closes DNS rebinding: a website the user
  visits cannot resolve its own domain to `127.0.0.1` and talk to the local
  service. Add extra hostnames with `CODEX_AGENT_ALLOWED_HOSTS` if the tunnel
  rewrites `Host`.
- The workspace path must be absolute, existing, and logically under the
  allowed root. A symlink located under that root is supported: it is resolved
  before the canonical path is sent to Codex. A path supplied outside the root
  is still rejected.
- For an accepted symlink, the root is a logical entrypoint boundary; the
  symlink target may therefore live outside the root's physical directory.
- NUL bytes, `..` segments, and invalid roots are rejected.
- The remote client cannot choose `config`, model, sandbox, or permissions;
  environment overrides are administrative and local to the process.
- These tools are not read-only. Review Codex approvals before accepting
  commands, file changes, or permissions.
- Non-loopback binds require the explicit opt-in
  `CODEX_AGENT_ALLOW_NON_LOOPBACK=1`, and only when a tunnel covers the whole
  transport. The tunnel is not part of this repository.

## Administrative configuration

- `HOST` and `PORT`: default `127.0.0.1:8787`.
- `CODEX_AGENT_ALLOW_NON_LOOPBACK=1`: permits a non-loopback bind, only with
  equivalent external protection.
- `CODEX_AGENT_ALLOWED_HOSTS`: comma-separated extra hostnames accepted in the
  `Host` header on `/mcp`. Only needed if the tunnel forwards its own `Host`
  instead of the loopback upstream.
- `CODEX_BIN`: local binary; defaults to `codex`.
- `CODEX_RPC_TIMEOUT_MS`: generic RPC timeout; defaults to `30000` ms.
- `CODEX_SHUTDOWN_TIMEOUT_MS`: graceful shutdown wait; defaults to `2000` ms.
- `CODEX_AGENT_STATE_FILE`: optional state JSON location.
- `CODEX_WORKSPACE_ROOT`: optional administrative root; defaults to
  `~/workspace`. Must be an existing absolute path.
- `CODEX_AGENT_MODEL` and `CODEX_AGENT_REASONING_EFFORT`: optional local
  overrides; without them Codex uses its own local configuration.

## Protocol compatibility

The implementation is pinned against the observed protocol of
`codex-cli 0.147.0`, app-server v2. The installed binary is the authority:
OpenAI/Codex can change independently of your local CLI.

The client uses `initialize` → `initialized`, bidirectional JSONL, and the
required RPCs `thread/start`, `thread/resume`, `thread/list`, `thread/read`,
`turn/start`, and `turn/interrupt`, plus server-initiated approvals.

The generated TypeScript bindings in `protocol/codex-0.147.0-ts/` are tracked
because the code imports them for build-time type safety.

The JSON schemas are **not** tracked — nothing in the runtime or the build
consumes them, so the repository does not carry hundreds of derived files. If
you want them as a protocol reference, generate them against your installed
binary:

```bash
codex app-server generate-json-schema --out protocol/codex-0.147.0-json-schema
```

That directory is in `.gitignore`. To move the pin to another version, install
and verify the new CLI and regenerate the bindings:

```bash
codex app-server generate-ts --out protocol/codex-<version>-ts
```

Then review imports, approvals, and tests against the installed binary.

## Local validation

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

The optional integration test against the installed binary:

```bash
CODEX_REAL_APP_SERVER=1 npm test -- --test-name-pattern='installed codex'
```

## Documentation and sources

Official OpenAI documentation this project is built against:

- [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [`openai/tunnel-client`](https://github.com/openai/tunnel-client)
- [tunnel-client onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)
- [tunnel-client configuration reference](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [tunnel-client permissions](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)
- [tunnel-client troubleshooting](https://github.com/openai/tunnel-client/blob/master/docs/troubleshooting.md)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
- [MCP in ChatGPT](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)

Everything outside those interfaces — the job model, the compact snapshot, the
approval routing by `request_id`, the recovery semantics, and the workspace
validation — is this project's own design.

## License

MIT. See [LICENSE](LICENSE).
