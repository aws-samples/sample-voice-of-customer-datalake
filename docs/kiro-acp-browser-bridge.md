# Driving Kiro CLI from a Browser over ACP

Research notes on driving a local `kiro-cli` from a web page through the Agent Client Protocol (ACP). This is a developer-tooling question. It is not part of the VoC deployment, and nothing here should be wired into the deployed VoC frontend (see [VoC-specific constraints](#voc-specific-constraints)).

Researched October 2026 against `kiro-cli 2.27.1`.

## The problem

`kiro-cli acp` runs Kiro as an ACP agent. It speaks JSON-RPC 2.0 as newline-delimited JSON over **stdin/stdout** ([Kiro CLI 1.25 changelog](https://kiro.dev/changelog/cli/1-25/), [Kiro ACP docs](https://kiro.dev/docs/cli/acp/)). ACP clients are normally editors such as Zed or JetBrains, which spawn the agent as a subprocess ([ACP overview](https://agentclientprotocol.com/protocol/overview)).

A web page cannot spawn processes or read stdio. Driving Kiro from a browser therefore needs a local process in between:

```
Browser page (ACP client UI)
      │  WebSocket / HTTP+SSE        ← the attack surface this doc is about
      ▼
Local bridge (Node / Python / Rust)
      │  stdin/stdout, NDJSON JSON-RPC
      ▼
kiro-cli acp   →  tools, MCP servers, shell, file edits run on THIS machine
```

Kiro's own Web and Mobile apps also speak ACP, with Kiro extensions under a `_kiro/` method namespace ([How Kiro works](https://kiro.dev/docs/how-kiro-works/)). So the protocol supports a browser client. The missing piece is the transport.

### What a browser client must implement

| Direction | Message | Notes |
|---|---|---|
| client → agent | `initialize` | Advertise **no** `fs` or `terminal` client capabilities (see [S7](#s7-do-not-advertise-client-filesystem-or-terminal-capabilities)) |
| client → agent | `session/new` (`cwd`, `mcpServers`) | `cwd` must be an absolute path |
| client → agent | `session/prompt`, notification `session/cancel` | |
| agent → client | notifications `session/update` | Streamed message chunks, tool calls, diffs, plans |
| agent → client | **request** `session/request_permission` | The page must answer. If it never does, the turn hangs |
| either | `_kiro/*` | Kiro extensions: slash commands, MCP, session management |

`kiro-cli acp` flags that matter for security (from `kiro-cli acp --help`):

| Flag | Effect |
|---|---|
| `-a, --trust-all-tools` | Auto-approves **every** permission request. No human in the loop |
| `--trust-tools <names>` | Auto-approves only the named tools |
| `--agent <name>` | Starts with a specific Kiro agent config, so you can pick one with a narrow tool list |

## Options

### A. Use an ACP-native client instead of a browser

Zed, JetBrains IDEs, Neovim, Emacs and Eclipse all speak ACP and spawn `kiro-cli acp` directly over stdio ([Kiro adopts ACP](https://kiro.dev/blog/kiro-adopts-acp/)). There is no network listener, no bridge and no token.

**Pick this if the browser isn't a hard requirement.** It is the only option with no new attack surface.

### B. Write your own minimal WebSocket bridge

This is a short Node or Python process you control end to end. You decide which methods get forwarded, where the agent may work, and what happens to permission requests. Recommended if you need a browser UI. **This repo ships one:** see [Implementation in this repo](#implementation-in-this-repo-toolskiro-acp-bridge).

### C. `aws-samples/sample-acp-bridge` (Python, HTTP + SSE)

[github.com/aws-samples/sample-acp-bridge](https://github.com/aws-samples/sample-acp-bridge) exposes Kiro CLI, Claude Code, Codex and others as an HTTP API. It has a process pool, SSE streaming, async jobs with webhook callbacks, an opt-in web UI at `/ui`, and Bearer token plus IP allowlist auth.

Its documented defaults are unsafe for a laptop:

| Documented default | Risk |
|---|---|
| `server.host: "0.0.0.0"` | Listens on every interface, including Wi-Fi and VPN |
| `acp_args: ["acp", "--trust-all-tools"]` | Kiro runs any tool without asking |
| `session/request_permission` auto-replied with `allow_always` | Even without the flag, nobody approves anything |
| `/ui` and `/health` unauthenticated | The UI page is served to anyone who can reach the port |
| `working_dir: "/tmp"` plus per-request `cwd` | The caller picks the directory the agent works in |
| OpenClaw tools proxy (`message`, `nodes`, `browser`, `gateway`) | Widens the blast radius beyond the local machine |

It is an aws-samples repo: sample code, not a maintained product. If you use it, change every row above. Bind to `127.0.0.1`, remove `--trust-all-tools`, replace the auto-allow with a real decision, and pin and review the commit you run.

### D. `robert-mcdermott/kiro-acp-gateway` (Python, OpenAI/Anthropic-compatible API)

[github.com/robert-mcdermott/kiro-acp-gateway](https://github.com/robert-mcdermott/kiro-acp-gateway) puts OpenAI- and Anthropic-compatible endpoints in front of `kiro-cli acp`. It also ships a Python ACP client library and CLI. Use it if your web app already talks to an LLM API.

Security features it documents:
- API key on `/v1/*`.
- `KIRO_GATEWAY_ALLOWED_WORKSPACES` allowlist.
- Ordered allow/deny permission rules, e.g. `deny:Read(**/.env)` and `allow:Bash(git status*)`.
- An audit ledger.
- Per-request overrides only when explicitly enabled.
- Its rules can narrow Kiro's own `permissions.yaml` but not widen it.

Caveats:
- A server has no interactive "ask". The README recommends `allow-always` on your own machine, which leaves no human in the loop.
- **If no key is configured, any key is accepted.**
- The README doesn't mention CORS. I haven't checked whether a browser can call it directly.

It is a personal repo: pin and review.

### E. `ytthuan/acp-ws-bridge` (Rust, transparent WebSocket relay)

[github.com/ytthuan/acp-ws-bridge](https://github.com/ytthuan/acp-ws-bridge) is a WebSocket-to-stdio relay built for GitHub Copilot CLI. `--acp-command` takes an exact command and doesn't run it through a shell, so it can likely launch `kiro-cli acp` (untested). It supports TLS and documents Tailscale Serve for remote access.

The README describes it as passing every message through unmodified, so it does no method filtering. I found no client authentication or Origin check documented. Without one, any web page can drive it (see [S1](#s1-any-web-page-can-open-a-websocket-to-localhost)).

### F. Non-browser remote clients

[ajitnk-lab/kiro-acp-telegram-bot](https://github.com/ajitnk-lab/kiro-acp-telegram-bot) drives Kiro over ACP from Telegram. It has the same threat model as a public endpoint: whoever controls the chat controls your machine.

### Comparison

| | Transport | Human approves tools | Method filter | Workspace allowlist | Safe defaults |
|---|---|---|---|---|---|
| A. ACP editor | stdio | Yes (editor UI) | n/a | Editor project | Yes |
| B. Own bridge | WebSocket | Yes, if you build it | Yes, if you build it | Yes, if you build it | You decide |
| C. sample-acp-bridge | HTTP/SSE | **No** (auto-allow) | No | Per-request `cwd` | **No** |
| D. kiro-acp-gateway | OpenAI/Anthropic HTTP | No (policy rules) | API surface | Yes | Partly (key optional) |
| E. acp-ws-bridge | WebSocket | Depends on client | **No** | No | **No auth documented** |

The table reflects each project's README as read in October 2026, not a code audit.

## Security analysis

The core fact: **anything that can send a `session/prompt` to the bridge can run commands as you.** Kiro runs with your user account, your `~/.aws`, `~/.ssh`, git and single sign-on credentials, your MCP servers, and your network position. A bridge is a remote shell with a language model in front of it. Every control below exists to make sure only you can reach it, only where you intend, with you approving the dangerous steps.

### S1. Any web page can open a WebSocket to localhost

WebSockets are **not** covered by the same-origin policy or CORS. A page on `evil.example` can run `new WebSocket('ws://127.0.0.1:8765')`, and the bridge receives the connection. This is cross-site WebSocket hijacking. Binding to `127.0.0.1` stops other machines but **does not stop other origins in your own browser**.

Controls:
- Check the `Origin` header against an exact allowlist on the upgrade request. JavaScript in a browser cannot forge `Origin`.
- Also require a secret token. Local non-browser processes (other users, malware, a compromised `npm` postinstall) can set any `Origin` they like.

Recent Chrome versions add a "local network access" permission prompt for public sites reaching local addresses. That is a mitigation, not a control. Don't rely on it, and don't train yourself to click Allow.

### S2. DNS rebinding

An attacker domain can resolve to `127.0.0.1` after the page loads, which makes the attacker's page same-origin with whatever the bridge serves over HTTP.

- The WebSocket Origin check still sees the attacker's origin, so it holds.
- Any **HTTP** route on the bridge (a UI page, a `/token` endpoint, a health route that leaks state) must check the `Host` header against `127.0.0.1:<port>` / `localhost:<port>` exactly.
- Never serve the token over HTTP without that check.

### S3. Token handling

- Generate a fresh 32-byte random token per bridge launch, and compare it in constant time.
- **Don't put it in the URL query.** URLs end up in browser history, logs, crash reports and `Referer` headers. Send it in the `Sec-WebSocket-Protocol` header instead (a browser `WebSocket` can set this as its second argument), or as the first frame before anything else is accepted.
- In the page, keep it in memory only. No `localStorage` or `sessionStorage`, where any XSS can read it.
- The bridge prints it once to the terminal you started it from, and you paste it into the page.

### S4. Never auto-approve, and treat agent input as hostile

This is the most important rule for *this* repository, see [VoC-specific constraints](#voc-specific-constraints).

The agent reads content it doesn't control: repo files, fetched web pages, MCP results, scraped reviews. Text in any of those can carry indirect prompt-injection instructions. With `--trust-all-tools` or an auto-`allow_always` responder, an injected instruction becomes code execution with no human checkpoint.

- Don't start `kiro-cli acp` with `-a` / `--trust-all-tools`. If you must pre-trust, use `--trust-tools` with read-only tools only.
- Start with `--agent <name>` pointing at a Kiro agent config whose tool list is as narrow as the job allows.
- Show every `session/request_permission` to the human, with the exact command or path. Don't rely only on the agent-supplied title, which the model writes and an injection can shape.
- Default to `reject_once` on timeout, page close or bridge disconnect. Never default to allow.
- Prefer `allow_once` over `allow_always`.
- Keep Kiro's own `deny` rules (`~/.kiro/settings/permissions.yaml` on the v3 engine) for secrets paths and destructive commands. Bridge-side rules should only narrow them.

### S5. Restrict methods and workspaces at the bridge

Don't build a transparent relay. Allowlist the browser→agent methods you actually use: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, plus JSON-RPC **responses** to requests the agent really sent.

- Drop everything else, including `_kiro/*` methods that change trust, agents or settings, unless you have reviewed each one.
- Validate `cwd` in `session/new` and `session/load`. Resolve it with `realpath`, so symlinks and `..` can't escape, and require it to sit inside an allowlisted workspace root.
- **Strip `mcpServers` from `session/new` and `session/load`.** An ACP stdio MCP server entry is a `command` + `args` the agent spawns, so a page that can set it can run any binary without a single permission prompt. The bridge forces it to `[]`; configure MCP servers in Kiro itself.
- Accept text and image prompt blocks only, and drop any image `uri`. `resource_link` / `resource` blocks and image URIs let the page point the agent at arbitrary `file://` URIs. Validate image bytes against the model limits, because a refused image stays in the session history and wedges it.
- Reject a response whose `id` doesn't match a pending agent request. Otherwise the page could pre-answer permission prompts. Also check that the chosen `optionId` was offered, and refuse `allow_always`.
- Set a maximum frame size, reject binary frames and non-JSON-RPC payloads, and allow one connection (one agent process) at a time.

### S6. Limit what a compromise can reach

The token and Origin check protect the door. These limit the damage once something gets through it.

- Spawn the agent with a scrubbed environment (`PATH`, `HOME`, locale) so tokens in your shell env such as `AWS_*`, `GITHUB_TOKEN` and `*_API_KEY` aren't inherited. This does **not** stop the agent's tools reading `~/.aws/credentials` from disk.
- For real isolation, run the bridge and `kiro-cli` in a container, devcontainer or separate OS user that only mounts the target workspace, and use least-privilege, short-lived AWS credentials there. This applies the [production safety rules](../.kiro/steering) in a different setting: the agent should never hold Admin or production credentials in a browser-driven session.
- Spawn the agent without a shell (`spawn(cmd, args)`, never `exec(string)`). Kill its whole process group when the socket closes, and add an idle timeout.

### S7. Do not advertise client filesystem or terminal capabilities

In ACP the *client* can offer `fs/read_text_file`, `fs/write_text_file` and `terminal/*` to the agent. A browser can't implement these, and implementing them in the bridge creates a second, unreviewed file and exec API with path-traversal risk. Advertise `fs: { readTextFile: false, writeTextFile: false }, terminal: false` and let Kiro use its own permission-gated tools.

### S8. The web UI is part of the trust boundary

An XSS in the client page holds the token and the open socket, so XSS becomes RCE on the developer's machine. Agent output contains attacker-influenced text (S4).

- Render markdown without raw HTML (e.g. `react-markdown` without `rehype-raw`), and allow only `http`/`https` link schemes.
- Never use `dangerouslySetInnerHTML` on agent output.
- Serve the page with a strict CSP: no inline script, `connect-src` limited to the bridge's exact `ws://127.0.0.1:<port>`.
- Don't load third-party scripts into the page.

### S9. Remote access (phone, another laptop)

Don't port-forward or use a public tunnel such as ngrok or Cloudflare quick tunnels. Even with a token, that puts a remote shell on the internet.

If you need it remotely:
- Use an SSH local forward (`ssh -L 8765:127.0.0.1:8765 host`), or Tailscale with ACLs restricting the port to your own devices.
- Use TLS end to end (`wss://`), and keep the Origin and token checks anyway.
- Treat `0.0.0.0` binds as a defect (see option C).

### S10. Logs, transcripts and supply chain

- Don't log raw frames. They carry source code, diffs and whatever secrets the agent read. If you keep transcripts, write them `0600` outside the repo.
- Never commit the token, and don't echo it into shell history (`export TOKEN=...` lines).
- Third-party bridges are small, recently written projects that sit directly on a code-execution path. Pin an exact commit or version, read the code that handles auth and permissions before running it, and re-review on upgrade.

### Security checklist

- [ ] Listener bound to `127.0.0.1` (or a Unix socket behind a local proxy), never `0.0.0.0`
- [ ] Exact `Origin` allowlist on the WebSocket upgrade
- [ ] `Host` allowlist on every HTTP route
- [ ] Per-launch random token, constant-time compare, not in the URL, memory-only in the page
- [ ] No `--trust-all-tools`, no auto-allow responder; permission prompts shown verbatim, default reject
- [ ] Method allowlist; `mcpServers` stripped; text and limit-checked image prompts only; responses only to pending agent request ids with an offered, non-`always` option; frame size cap; one connection
- [ ] `cwd` realpath-checked against workspace allowlist
- [ ] No client `fs` / `terminal` capabilities advertised
- [ ] Scrubbed env; container or separate user with least-privilege, short-lived credentials
- [ ] Safe markdown rendering and strict CSP in the client page
- [ ] No public tunnels; SSH forward or Tailscale ACLs plus `wss://` for remote use
- [ ] Third-party bridge pinned and reviewed

## Implementation in this repo: `tools/kiro-acp-bridge`

Option B, built and validated. You type work into a page in your browser, Kiro executes it on this machine (after you approve each tool call), and the reply streams back into the page.

```bash
cd tools/kiro-acp-bridge && npm ci
node src/cli.mjs --workspace ~/code/my-project            # prints the URL and a one-time token
# open http://127.0.0.1:8765/, paste the token, Connect, send work
```

Options: `--workspace <dir>` (repeatable; the first is where the session starts), `--port`, `--agent <kiro-agent>` (use one with a narrow tool list), `--model`, `--permission-timeout <seconds>` (default 120). There is deliberately no flag to bind another interface or pass `--trust-all-tools` / `--trust-tools`; `startBridge` throws if those agent flags appear.

| File | Role |
|---|---|
| `src/protocol.mjs` | Pure frame policy (Zod-validated): method allowlist, capability/MCP/cwd/prompt rewriting, permission-answer checks, agent→client request handling |
| `src/bridge.mjs` | HTTP + WebSocket server on `127.0.0.1`: Host/Origin/token checks, one session, agent process lifecycle, bridge-side permission timeout |
| `src/cli.mjs` | Argument parsing; prints URL and token to the terminal only |
| `public/` | Client page served by the bridge (same origin, strict CSP, `textContent`-only rendering, reject-first permission dialog, Escape = reject; `images.js` fits attachments to the limits, `notify.js` desktop notifications) |
| `test/*.test.mjs` | `node:test` suite with a scripted fake agent (run by `scripts/validate.sh` and CI) |
| `test/e2e-kiro.mjs` | Live check against the real `kiro-cli acp` (`npm run e2e:kiro`; needs a logged-in CLI, not run in CI) |

How the checklist maps to the code:

| Control | Enforcement |
|---|---|
| S1 Origin + token | Upgrade on `/acp` needs `Origin` = `http://127.0.0.1:<port>` or `http://localhost:<port>` (else 403) and the token as a `Sec-WebSocket-Protocol` entry (`acp-token.<hex>`, constant-time compare, else 401) |
| S2 rebinding | Every HTTP route and the upgrade need `Host` = `127.0.0.1:<port>` / `localhost:<port>` (else 403); static files come from a fixed route table, never a path join |
| S3 token | 32 random bytes per launch; printed once to the terminal; the page keeps it in memory and clears the input; `/config.json` never contains it |
| S4 approval | No trust flags accepted; every `session/request_permission` goes to the page; `allow_always` is neither shown nor accepted; unanswered prompts are rejected after the timeout by the bridge itself |
| S5 policy | Method allowlist; `mcpServers` forced to `[]`; `cwd` realpath-checked; text and image prompt blocks only, images re-validated (see [Images](#images)) with any `uri` stripped; answers only to pending agent request ids with an offered `optionId`; frame cap sized for 4 maximum images (21 MiB); 32 MiB cap per agent output line; binary dropped; one connection (409 for a second) |
| S6 blast radius | Agent spawned without a shell, in its own process group (killed on disconnect), with only `PATH HOME USER LOGNAME SHELL TMPDIR LANG LC_ALL TERM` from the environment |
| S7 capabilities | `initialize` is rewritten to `fs: false, terminal: false`; any `fs/*` or `terminal/*` request from the agent is answered `-32601` by the bridge and never reaches the page |
| S8 UI | CSP `default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:<port> ws://localhost:<port>; img-src 'self' blob:; frame-ancestors 'none'` (`blob:` only for local attachment previews), no inline script, no third-party code, agent text written with `textContent` only |

Validation run on 4 October 2026 (macOS, Node 24, `kiro-cli 2.27.1`):

- `npm test`: 119 tests pass, including the notifier (background-only, opt-out, permission states, click-to-focus). They cover:
  - token, Origin, Host and path refusal; CSP headers; Host-checked `/config.json`
  - method blocking, MCP/capability stripping, and cwd escapes (symlink, `..`, prefix sibling, relative, missing)
  - prompt blocks: non-text/non-image refusal, image header parsing for every format, size/pixel/format/base64 limits, per-prompt and per-session budgets
  - permissions: forged `allow_always`, unoffered and pre-emptive answers, the bridge-side timeout
  - fs requests answered by the bridge, the one-connection limit, the agent being killed on disconnect, the agent output line cap, a missing agent binary, and CLI argument handling
- `npm run e2e:kiro` against the real Kiro:
  - Work was sent through the bridge, with one permission prompt (`Running: echo … > proof.txt && cat proof.txt`) approved once. The file appeared in the throwaway workspace and the reply contained the command output. This also confirmed Kiro authenticates with the scrubbed environment.
  - A second turn sent a solid green PNG, and the model answered "green".
- Headless Chromium against the CLI-started bridge, text turn:
  - A page on a foreign origin holding the valid token was refused.
  - The bridge page connected, the token field was cleared, and the permission dialog showed the exact `rawInput.command` with "No" focused first.
  - Approving ran the command locally and the reply rendered.
- Headless Chrome for Testing against the CLI-started bridge, image and notification checks:
  - A 10 MiB 3200×2400 PNG was resized in the browser to a 1.12 MiB 2000×1500 JPEG, and Kiro read the text drawn in it.
  - With the tab backgrounded, "Kiro finished" and "Kiro needs your approval" notifications fired. The approval one stays until clicked, and neither contains the command text.
  - Nothing fired while the tab was in the foreground. The tab title showed `(!)` while approval was pending.
  - An SVG was refused, and there were no CSP violations or console errors in any run.

### Images

The page attaches up to 4 images per prompt (file picker or paste) and 20 per session. Each is fitted into the model endpoint's limits in the browser before sending, and the bridge re-checks the bytes, reading dimensions from the file header and never trusting the page's values.

| Limit | Value | Why |
|---|---|---|
| Base64 payload | 5 MiB (5,242,880 B) per image | Endpoint error `image exceeds 5 MB maximum: N bytes > 5242880 bytes`. The check is on the *encoded* size, so the real raw ceiling is **3.75 MiB, not 4 MB**: a 4 MB image is 5.33 MB of base64 and is refused ([kirodotdev/Kiro#11497](https://github.com/kirodotdev/Kiro/issues/11497), [#10783](https://github.com/kirodotdev/Kiro/issues/10783), [#9707](https://github.com/kirodotdev/Kiro/issues/9707)) |
| JPEG raw | 3.75 MiB | Same limit in raw bytes |
| PNG / GIF / WebP raw | 2.5 MiB | Measured here (see below): Kiro re-encodes prompt images and a PNG can come out larger |
| Pixels | 2000 px per side | Many-image cap that wedges sessions once history holds more than 20 images ([#11663](https://github.com/kirodotdev/Kiro/issues/11663), [#11780](https://github.com/kirodotdev/Kiro/issues/11780)) |
| Count | 4 per prompt, 20 per session | Headroom under the 100-image wall ([#11664](https://github.com/kirodotdev/Kiro/issues/11664)); Kiro's own read tool adds images the bridge cannot see |
| Formats | PNG, JPEG, GIF, WebP | SVG is refused (script-capable, not raster) |

What was measured against `kiro-cli 2.27.1` over ACP:
- **Kiro re-encodes images before sending them.** A JPEG padded to 5.09 MiB of base64 and a PNG padded to 5.01 MiB were both accepted, because the padding was stripped.
- JPEG re-encodes never grew. A 2000×2000 noise JPEG at quality 1.0 (3.67 MiB) passed.
- A browser-made 3.73 MiB PNG of 2000×1500 noise was re-encoded to 6,069,576 bytes of base64 (+16.5%) and refused upstream. **Kiro then dropped the image silently:** the turn succeeded and the model said it saw no image. The only trace is `image exceeds 5 MB maximum` in `$TMPDIR/kiro-log/kiro-chat.log`.

That silent drop is why non-JPEG images get the 2.5 MiB cap, with 1.5× headroom over the observed inflation. When a PNG is too large the page falls back to JPEG, then shrinks if needed. Before the cap, the browser test reproduced the drop exactly; after it, the same image arrived as a JPEG and was read correctly.

### Notifications

Desktop notifications come from the browser Notification API: there is no push service and nothing leaves the machine. They fire only while the tab is in the background or unfocused:
- **"Kiro needs your approval"** stays until clicked (`requireInteraction`).
- **"Kiro finished"** and **"Kiro turn failed"** at the end of a turn.
- **"Kiro bridge disconnected"** when a connected session drops.

Bodies are generic on purpose: notifications can show on a lock screen, so they never include the command, paths or agent text. Clicking one focuses the tab. Permission is requested when you click Connect, and there is a checkbox to turn them off. The tab title also shows `(!)` while an approval is pending.

Known limits:
- Kiro's permission requests don't carry a tool `kind`, so the dialog says "not provided by the agent". Judge the request by the exact input shown.
- Agent→page notifications, including `_kiro/*`, are forwarded unfiltered. They are rendered as text or ignored, never executed.
- One agent output line may be up to 32 MiB. Past that the session is closed rather than buffered without limit.
- One workspace session per bridge. Run a second bridge on another port for a second project.
- Plain `ws://` on loopback. For another device, use an SSH forward; there is no TLS mode (S9).
- Animated GIFs that need resizing become a single JPEG frame.

## VoC-specific constraints

- **Do not connect the deployed VoC frontend to a local bridge.** VoC renders customer-supplied and scraped text by design: public feedback forms, web scrapers, app reviews. That makes it the worst possible host for a token that controls a developer's shell. Any rendering bug in VoC would become code execution on the operator's laptop. Keep any bridge client as a separate, minimal page on its own `localhost` origin.
- **Don't point a bridged, auto-approving agent at VoC data.** Feedback text is attacker-controlled input. Using Kiro to analyse exports, the raw S3 data or DynamoDB records through a bridge is an indirect prompt-injection path (S4). Use read-only tools and per-call approval for that work.
- **Use read-only AWS credentials.** In a browser-driven session, never give the agent Admin or production credentials for the VoC accounts.
- **The bridge is developer tooling, not part of the deployment.** `tools/kiro-acp-bridge` adds no stack or route and changes nothing in `api-stack.ts`, the five-stack cap, or the VoC auth model.

## Sources

- [Kiro CLI: ACP](https://kiro.dev/docs/cli/acp/) · [Kiro CLI 1.25 changelog](https://kiro.dev/changelog/cli/1-25/) · [How Kiro works](https://kiro.dev/docs/how-kiro-works/) · [Kiro adopts ACP](https://kiro.dev/blog/kiro-adopts-acp/)
- [Agent Client Protocol overview](https://agentclientprotocol.com/protocol/overview)
- [aws-samples/sample-acp-bridge](https://github.com/aws-samples/sample-acp-bridge) · [robert-mcdermott/kiro-acp-gateway](https://github.com/robert-mcdermott/kiro-acp-gateway) · [ytthuan/acp-ws-bridge](https://github.com/ytthuan/acp-ws-bridge) · [ajitnk-lab/kiro-acp-telegram-bot](https://github.com/ajitnk-lab/kiro-acp-telegram-bot)
- Local: `kiro-cli acp --help` (v2.27.1)

Third-party project descriptions are paraphrased from their READMEs.
