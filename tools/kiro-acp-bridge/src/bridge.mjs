/**
 * Localhost bridge: browser page ⇄ WebSocket ⇄ `kiro-cli acp` (stdio NDJSON).
 *
 * Network controls (see docs/kiro-acp-browser-bridge.md for the threat model):
 *   - binds 127.0.0.1 only;
 *   - every HTTP request and the WebSocket upgrade require an exact Host
 *     (DNS-rebinding defence);
 *   - the upgrade requires an exact Origin (cross-site WebSocket hijacking)
 *     AND the per-launch token in Sec-WebSocket-Protocol (local processes can
 *     forge Origin);
 *   - one browser connection, and so one agent process, at a time.
 * Frame policy lives in protocol.mjs.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { IMAGE_LIMITS, MAX_IMAGE_BASE64_BYTES, MAX_IMAGES_PER_PROMPT } from './images.mjs'
import {
  APP_PROTOCOL,
  PERMISSION_TIMEOUT_METHOD,
  assertSafeAgentArgs,
  blockedReply,
  classifyAgentLine,
  createToken,
  offeredToken,
  permissionTimeoutReply,
  resolveWorkspaceRoots,
  tokenMatches,
  vetClientFrame,
} from './protocol.mjs'

const BIND_HOST = '127.0.0.1'
const WS_PATH = '/acp'
/** Largest browser frame: a prompt with the maximum number of maximum-size images, plus text. */
const MAX_FRAME_BYTES = MAX_IMAGES_PER_PROMPT * MAX_IMAGE_BASE64_BYTES + 1024 * 1024
/** Largest single NDJSON line accepted from the agent before the session is torn down. */
const DEFAULT_MAX_AGENT_LINE_BYTES = 32 * 1024 * 1024
const PUBLIC_DIR = new URL('../public/', import.meta.url)
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/images.js', { file: 'images.js', type: 'text/javascript; charset=utf-8' }],
  ['/notify.js', { file: 'notify.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
])
/** Environment the agent inherits: enough to find binaries and Kiro's own credentials, no shell secrets. */
const AGENT_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']

function agentEnv() {
  const env = {}
  for (const key of AGENT_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function securityHeaders(port) {
  const wsOrigins = `ws://127.0.0.1:${port} ws://localhost:${port}`
  return {
    'Content-Security-Policy':
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${wsOrigins}; ` +
      "img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  }
}

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Splits a byte stream into newline-terminated lines with a hard per-line cap,
 * so a runaway agent cannot make the bridge buffer without limit.
 */
export function readLines(stream, { maxLineBytes, onLine, onOverflow }) {
  let chunks = []
  let buffered = 0
  let overflowed = false
  stream.on('data', (data) => {
    if (overflowed) return
    let start = 0
    let newline = data.indexOf(0x0a, start)
    while (newline !== -1) {
      chunks.push(data.subarray(start, newline))
      const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '')
      chunks = []
      buffered = 0
      if (line.length > 0) onLine(line)
      start = newline + 1
      newline = data.indexOf(0x0a, start)
    }
    const rest = data.subarray(start)
    buffered += rest.length
    if (buffered > maxLineBytes) {
      overflowed = true
      chunks = []
      onOverflow()
      return
    }
    if (rest.length > 0) chunks.push(rest)
  })
}

/**
 * Starts the bridge.
 * @param {object} options
 * @param {string[]} options.workspaceRoots directories the agent may work in
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.agentCommand]
 * @param {string[]} [options.agentArgs]
 * @param {string} [options.token]
 * @param {number} [options.permissionTimeoutMs] unanswered permission prompts are rejected after this
 * @param {number} [options.maxAgentLineBytes] the session is closed if one agent line exceeds this
 * @param {(msg: string) => void} [options.log]
 */
export async function startBridge({
  workspaceRoots,
  port = 8765,
  agentCommand = 'kiro-cli',
  agentArgs = ['acp'],
  token = createToken(),
  permissionTimeoutMs = 120_000,
  maxAgentLineBytes = DEFAULT_MAX_AGENT_LINE_BYTES,
  log = (msg) => console.error(`[kiro-acp-bridge] ${msg}`),
}) {
  assertSafeAgentArgs(agentArgs)
  const roots = resolveWorkspaceRoots(workspaceRoots)
  const state = { port, activeSession: null }

  const allowedHosts = () => new Set([`127.0.0.1:${state.port}`, `localhost:${state.port}`])
  const allowedOrigins = () => new Set([`http://127.0.0.1:${state.port}`, `http://localhost:${state.port}`])

  const server = createServer((req, res) => {
    void handleHttp(req, res).catch((err) => {
      log(`HTTP handler failed: ${err.message}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  async function handleHttp(req, res) {
    const headers = securityHeaders(state.port)
    if (!allowedHosts().has(req.headers.host ?? '')) {
      res.writeHead(403, headers).end()
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { ...headers, Allow: 'GET' }).end()
      return
    }
    const path = new URL(req.url ?? '/', 'http://bridge.invalid').pathname
    if (path === '/favicon.ico') {
      res.writeHead(204, headers).end() // browsers ask for it; answer without a 404 in the console
      return
    }
    if (path === '/config.json') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ workspace: roots[0], permissionTimeoutMs, images: IMAGE_LIMITS }))
      return
    }
    const entry = STATIC_FILES.get(path)
    if (!entry) {
      res.writeHead(404, headers).end()
      return
    }
    const body = await readFile(new URL(entry.file, PUBLIC_DIR))
    res.writeHead(200, { ...headers, 'Content-Type': entry.type }).end(body)
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols: (protocols) => (protocols.has(APP_PROTOCOL) ? APP_PROTOCOL : false),
  })

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://bridge.invalid').pathname
    if (path !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found')
    if (!allowedHosts().has(req.headers.host ?? '')) return rejectUpgrade(socket, 403, 'Forbidden')
    if (!allowedOrigins().has(req.headers.origin ?? '')) return rejectUpgrade(socket, 403, 'Forbidden')
    if (!tokenMatches(offeredToken(req.headers['sec-websocket-protocol']), token)) {
      return rejectUpgrade(socket, 401, 'Unauthorized')
    }
    if (state.activeSession) return rejectUpgrade(socket, 409, 'Conflict')
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.activeSession = attachSession(ws, {
        agentCommand,
        agentArgs,
        roots,
        permissionTimeoutMs,
        maxLineBytes: maxAgentLineBytes,
        log,
        onClose: () => {
          state.activeSession = null
        },
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, BIND_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Bridge did not bind a TCP port')
  state.port = address.port

  return {
    port: state.port,
    url: `http://127.0.0.1:${state.port}/`,
    token,
    /** pid of the running agent, for diagnostics and tests */
    agentPid: () => state.activeSession?.pid,
    close: async () => {
      state.activeSession?.shutdown('bridge closing')
      wss.close()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function attachSession(ws, { agentCommand, agentArgs, roots, permissionTimeoutMs, maxLineBytes, log, onClose }) {
  /** @type {Map<string|number, {options: Array<{optionId:string, kind:string}>, timer: NodeJS.Timeout}>} */
  const pendingPermissions = new Map()
  /** Images the page has sent per ACP session id (budget in images.mjs). */
  const imageCounts = new Map()
  let closed = false

  const agent = spawn(agentCommand, agentArgs, {
    cwd: roots[0],
    env: agentEnv(),
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: true, // own process group so shutdown reaches tools the agent started
    shell: false,
  })
  log(`agent started (pid ${agent.pid ?? 'n/a'})`)

  function shutdown(reason) {
    if (closed) return
    closed = true
    for (const { timer } of pendingPermissions.values()) clearTimeout(timer)
    pendingPermissions.clear()
    if (agent.pid !== undefined) {
      try {
        // Negative pid = the whole process group, including tool processes that outlive the agent
        process.kill(-agent.pid, 'SIGTERM')
      } catch {
        // group already gone
      }
    }
    // WebSocket close reasons are capped at 123 bytes and ws throws past that; err.message can be multi-byte
    const closeReason = Buffer.from(reason).subarray(0, 120).toString('utf8')
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, closeReason)
    log(`session closed: ${reason}`)
    onClose()
  }

  function sendToAgent(frame) {
    if (!closed && agent.stdin.writable) agent.stdin.write(`${frame}\n`)
  }

  function sendToPage(frame) {
    if (ws.readyState === ws.OPEN) ws.send(frame)
  }

  function trackPermission(id, options) {
    clearTimeout(pendingPermissions.get(id)?.timer) // a reused id must not leave a stray timer behind
    const timer = setTimeout(() => {
      if (!pendingPermissions.delete(id)) return
      log(`permission request ${String(id)} timed out; rejecting`)
      sendToAgent(permissionTimeoutReply(id, options))
      sendToPage(JSON.stringify({ jsonrpc: '2.0', method: PERMISSION_TIMEOUT_METHOD, params: { id } }))
    }, permissionTimeoutMs)
    pendingPermissions.set(id, { options, timer })
  }

  readLines(agent.stdout, {
    maxLineBytes,
    onOverflow: () => shutdown(`agent sent a line over ${maxLineBytes} bytes`),
    onLine: (line) => {
      const decision = classifyAgentLine(line)
      if (decision.kind === 'drop') return
      if (decision.kind === 'reply') return sendToAgent(decision.frame)
      if (decision.kind === 'permission') trackPermission(decision.id, decision.options)
      sendToPage(decision.frame)
    },
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const decision = vetClientFrame(data.toString('utf8'), { workspaceRoots: roots, pendingPermissions, imageCounts })
    if (decision.kind === 'forward') {
      if (decision.answeredPermissionId !== undefined) {
        clearTimeout(pendingPermissions.get(decision.answeredPermissionId)?.timer)
        pendingPermissions.delete(decision.answeredPermissionId)
      }
      sendToAgent(decision.frame)
      return
    }
    log(`client frame ${decision.kind === 'block' ? 'blocked' : 'dropped'}: ${decision.reason}`)
    if (decision.kind === 'block') sendToPage(blockedReply(decision.id, decision.reason))
  })

  ws.on('close', () => shutdown('browser disconnected'))
  ws.on('error', (err) => shutdown(`socket error: ${err.message}`))
  agent.on('error', (err) => shutdown(`agent failed to start: ${err.message}`))
  agent.on('exit', (code, signal) => shutdown(`agent exited (${signal ?? code})`))
  agent.stdin.on('error', (err) => shutdown(`agent stdin error: ${err.message}`))

  return { pid: agent.pid, shutdown }
}
