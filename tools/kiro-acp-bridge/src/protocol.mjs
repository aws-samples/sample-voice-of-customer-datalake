/**
 * Pure ACP frame policy for the browser bridge.
 *
 * Every frame crossing the bridge goes through one of these functions. The
 * browser is treated as a client that holds the token but may still be
 * compromised (XSS), so the bridge enforces the policy itself instead of
 * trusting what the page sends:
 *   - only an allowlisted set of client methods reaches the agent;
 *   - client fs/terminal capabilities are forced off;
 *   - client-supplied MCP servers are stripped (an MCP stdio entry is an
 *     arbitrary command the agent would spawn);
 *   - session cwd must resolve inside an allowlisted workspace root;
 *   - prompts carry text and image blocks only; images must fit the model
 *     endpoint's limits (images.mjs) so one bad image cannot wedge a session;
 *   - the page may only answer permission requests the agent actually sent,
 *     with an option the agent offered, and never with an "always" grant.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import { MAX_IMAGES_PER_PROMPT, MAX_IMAGES_PER_SESSION, validateImage } from './images.mjs'

export const APP_PROTOCOL = 'acp.v1'
export const TOKEN_PROTOCOL_PREFIX = 'acp-token.'
export const PERMISSION_METHOD = 'session/request_permission'
export const PERMISSION_TIMEOUT_METHOD = '_bridge/permission_timeout'
export const BLOCKED_METHOD = '_bridge/blocked'

/** Browser → agent methods the bridge forwards. Everything else is dropped. */
export const CLIENT_METHODS = new Set([
  'initialize',
  'session/new',
  'session/load',
  'session/prompt',
  'session/cancel',
])

/** Agent CLI flags that remove the human from the loop; the bridge refuses them. */
export const FORBIDDEN_AGENT_ARGS = new Set(['-a', '--trust-all-tools', '--trust-tools'])

const DISABLED_CLIENT_CAPABILITIES = Object.freeze({
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
})

const JSON_RPC_INVALID_REQUEST = -32600
const JSON_RPC_METHOD_NOT_FOUND = -32601

const idSchema = z.union([z.string(), z.number()])

const clientRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: idSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
})

const clientResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: idSchema,
  result: z.unknown(),
})

const sessionParamsSchema = z.looseObject({ cwd: z.string() })

const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() })
// z.object strips unknown keys, so an image `uri` (a file:// pointer) never reaches the agent
const imageBlockSchema = z.object({ type: z.literal('image'), mimeType: z.string(), data: z.string() })
const promptParamsSchema = z.looseObject({
  sessionId: z.string(),
  prompt: z.array(z.discriminatedUnion('type', [textBlockSchema, imageBlockSchema])).min(1),
})

const permissionOptionSchema = z.looseObject({
  optionId: z.string(),
  kind: z.string(),
})

const agentPermissionRequestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema,
  method: z.literal(PERMISSION_METHOD),
  params: z.looseObject({ options: z.array(permissionOptionSchema) }),
})

const agentMessageSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema.optional(),
  method: z.string().optional(),
})

const permissionResultSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('selected'), optionId: z.string() }),
    z.object({ outcome: z.literal('cancelled') }),
  ]),
})

/** @returns {string} a fresh 32-byte hex token */
export function createToken() {
  return randomBytes(32).toString('hex')
}

/** Reads the token the browser offered as a `Sec-WebSocket-Protocol` entry. */
export function offeredToken(protocolHeader) {
  if (typeof protocolHeader !== 'string') return ''
  const entry = protocolHeader
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))
  return entry ? entry.slice(TOKEN_PROTOCOL_PREFIX.length) : ''
}

/** Constant-time token comparison. */
export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Resolves workspace roots once at startup; throws if a root does not exist. */
export function resolveWorkspaceRoots(roots) {
  if (roots.length === 0) throw new Error('At least one workspace root is required')
  return roots.map((root) => realpathSync(root))
}

/** True when `cwd` is absolute and its realpath sits inside one of the roots. */
export function insideWorkspace(cwd, workspaceRoots) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false
  let real
  try {
    real = realpathSync(cwd)
  } catch {
    return false
  }
  return workspaceRoots.some((root) => real === root || real.startsWith(root + sep))
}

function blocked(id, reason) {
  return { kind: 'block', reason, id }
}

function vetPrompt(request, imageCounts) {
  const { id } = request
  const params = promptParamsSchema.safeParse(request.params)
  if (!params.success) return blocked(id, 'session/prompt accepts text and image content blocks only')

  const images = params.data.prompt.filter((block) => block.type === 'image')
  if (images.length > MAX_IMAGES_PER_PROMPT) {
    return blocked(id, `at most ${MAX_IMAGES_PER_PROMPT} images per prompt (got ${images.length})`)
  }
  const { sessionId } = params.data
  const used = imageCounts.get(sessionId) ?? 0
  if (used + images.length > MAX_IMAGES_PER_SESSION) {
    return blocked(id, `this session already holds ${used} of ${MAX_IMAGES_PER_SESSION} images; start a new session`)
  }
  for (const [index, image] of images.entries()) {
    const verdict = validateImage(image)
    if (!verdict.ok) return blocked(id, `image ${index + 1}: ${verdict.reason}`)
  }
  if (images.length > 0) imageCounts.set(sessionId, used + images.length)
  return forward({ ...request, params: params.data })
}

function vetClientRequest(request, { workspaceRoots, imageCounts }) {
  const { id, method } = request
  if (!CLIENT_METHODS.has(method)) return blocked(id, `method ${method} is not allowed`)

  if (method === 'initialize') {
    const params = z.looseObject({}).safeParse(request.params ?? {})
    if (!params.success) return blocked(id, 'initialize params must be an object')
    return forward({ ...request, params: { ...params.data, clientCapabilities: DISABLED_CLIENT_CAPABILITIES } })
  }

  if (method === 'session/new' || method === 'session/load') {
    const params = sessionParamsSchema.safeParse(request.params)
    if (!params.success) return blocked(id, `${method} requires an absolute cwd`)
    if (!insideWorkspace(params.data.cwd, workspaceRoots)) {
      return blocked(id, `cwd ${params.data.cwd} is outside the allowed workspaces`)
    }
    return forward({ ...request, params: { ...params.data, mcpServers: [] } })
  }

  if (method === 'session/prompt') return vetPrompt(request, imageCounts)

  return forward(request)
}

function forward(message) {
  return { kind: 'forward', frame: JSON.stringify(message) }
}

function vetPermissionAnswer(response, pendingPermissions) {
  const pending = pendingPermissions.get(response.id)
  if (!pending) return { kind: 'drop', reason: 'response to an unknown or expired request' }
  const result = permissionResultSchema.safeParse(response.result)
  if (!result.success) return { kind: 'drop', reason: 'malformed permission outcome' }

  const { outcome } = result.data
  if (outcome.outcome === 'selected') {
    const option = pending.options.find((o) => o.optionId === outcome.optionId)
    if (!option) return { kind: 'drop', reason: 'optionId was not offered by the agent' }
    if (option.kind === 'allow_always') return { kind: 'drop', reason: 'allow_always is disabled by the bridge' }
  }
  return {
    kind: 'forward',
    frame: JSON.stringify({ jsonrpc: '2.0', id: response.id, result: result.data }),
    answeredPermissionId: response.id,
  }
}

/**
 * Decides what to do with one text frame from the browser.
 * @returns {{kind:'forward', frame:string, answeredPermissionId?:string|number}
 *   | {kind:'block', reason:string, id?:string|number}
 *   | {kind:'drop', reason:string}}
 */
export function vetClientFrame(text, { workspaceRoots, pendingPermissions, imageCounts }) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return { kind: 'drop', reason: 'not JSON' }
  }

  const request = clientRequestSchema.safeParse(message)
  if (request.success) return vetClientRequest(request.data, { workspaceRoots, imageCounts })

  const response = clientResponseSchema.safeParse(message)
  if (response.success) return vetPermissionAnswer(response.data, pendingPermissions)

  return { kind: 'drop', reason: 'not a JSON-RPC 2.0 request or result response' }
}

/**
 * Decides what to do with one line from the agent's stdout.
 * @returns {{kind:'forward', frame:string}
 *   | {kind:'permission', id:string|number, options:Array<{optionId:string, kind:string}>, frame:string}
 *   | {kind:'reply', frame:string}
 *   | {kind:'drop'}}
 */
export function classifyAgentLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return { kind: 'drop' }
  }
  const envelope = agentMessageSchema.safeParse(message)
  if (!envelope.success) return { kind: 'drop' }

  const { id, method } = envelope.data
  const isRequest = method !== undefined && id !== undefined
  if (!isRequest) return { kind: 'forward', frame: line }

  const permission = agentPermissionRequestSchema.safeParse(message)
  if (permission.success) {
    return { kind: 'permission', id: permission.data.id, options: permission.data.params.options, frame: line }
  }
  // fs/*, terminal/* and any other client-side method: the bridge advertised
  // none of them, so it answers on the page's behalf instead of forwarding.
  return {
    kind: 'reply',
    frame: JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `${method} is not supported by this client` },
    }),
  }
}

/** The answer the bridge sends when the human did not decide in time. */
export function permissionTimeoutReply(id, options) {
  const reject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always')
  const outcome = reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' }
  return JSON.stringify({ jsonrpc: '2.0', id, result: { outcome } })
}

/** JSON-RPC error the page receives when one of its requests is blocked. */
export function blockedReply(id, reason) {
  if (id === undefined) {
    return JSON.stringify({ jsonrpc: '2.0', method: BLOCKED_METHOD, params: { reason } })
  }
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: JSON_RPC_INVALID_REQUEST, message: `Blocked by bridge policy: ${reason}` },
  })
}

/** Throws when the agent command line would bypass human approval. */
export function assertSafeAgentArgs(args) {
  const offending = args.find((arg) => FORBIDDEN_AGENT_ARGS.has(arg) || arg.startsWith('--trust-tools='))
  if (offending) throw new Error(`Refusing to start the agent with ${offending}: every tool call must be approved`)
}
