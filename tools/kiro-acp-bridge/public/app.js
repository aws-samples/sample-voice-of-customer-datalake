// Browser ACP client for kiro-acp-bridge.
// Security rules for this file: agent output is untrusted text, so it is only
// ever written with textContent (never innerHTML); the token lives in memory
// only; and every tool call needs an explicit click, defaulting to reject.

import { ImageRejected, prepareImage } from './images.js'
import { createNotifier } from './notify.js'

const APP_PROTOCOL = 'acp.v1'
const TOKEN_PROTOCOL_PREFIX = 'acp-token.'
const PERMISSION_METHOD = 'session/request_permission'
const PERMISSION_TIMEOUT_METHOD = '_bridge/permission_timeout'
const BLOCKED_METHOD = '_bridge/blocked'
const PAGE_TITLE = document.title

const $ = (id) => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing element #${id}`)
  return el
}

const ui = {
  workspace: $('workspace'),
  connectForm: $('connect-form'),
  token: $('token'),
  connect: $('connect'),
  status: $('status'),
  transcript: $('transcript'),
  promptForm: $('prompt-form'),
  prompt: $('prompt'),
  images: $('images'),
  imageLimits: $('image-limits'),
  attachments: $('attachments'),
  send: $('send'),
  cancel: $('cancel'),
  dialog: $('permission-dialog'),
  dialogTool: $('permission-tool'),
  dialogKind: $('permission-kind'),
  dialogDetail: $('permission-detail'),
  dialogCountdown: $('permission-countdown'),
  dialogOptions: $('permission-options'),
}

const notifier = createNotifier({ checkbox: $('notify'), status: $('notify-status') })

const state = {
  ws: null,
  nextId: 1,
  pending: new Map(), // our request id -> {resolve, reject}
  sessionId: null,
  workspace: null,
  permissionTimeoutMs: 120_000,
  imageLimits: null, // from /config.json; images are disabled until it loads
  attachments: [], // prepared images waiting for the next prompt
  sessionImages: 0, // images sent in this session (the bridge enforces the same budget)
  permissionQueue: [],
  activePermission: null, // {id, options, timer}
  agentEntry: null,
  toolEntries: new Map(),
  turnActive: false,
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const asText = (value) => (typeof value === 'string' ? value : '')

function setStatus(text) {
  ui.status.textContent = text
}

function addEntry(kind, text) {
  const li = document.createElement('li')
  li.className = kind
  li.textContent = text
  ui.transcript.append(li)
  li.scrollIntoView({ block: 'end' })
  return li
}

function setTurnActive(active) {
  state.turnActive = active
  const ready = state.sessionId !== null
  ui.prompt.disabled = !ready || active
  ui.send.disabled = !ready || active
  ui.images.disabled = !ready || active || state.imageLimits === null
  ui.cancel.disabled = !active
}

function setAwaitingApproval(waiting) {
  document.title = waiting ? `(!) Approval needed — ${PAGE_TITLE}` : PAGE_TITLE
}

function send(message) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message))
}

function request(method, params) {
  const id = state.nextId++
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

// ---- session/update rendering -------------------------------------------

function renderToolCall(update) {
  const id = asText(update.toolCallId)
  const title = asText(update.title) || 'tool call'
  const status = asText(update.status) || 'pending'
  let entry = state.toolEntries.get(id)
  if (!entry) {
    entry = { li: addEntry('tool', ''), title }
    state.toolEntries.set(id, entry)
  }
  if (asText(update.title)) entry.title = asText(update.title)
  entry.li.textContent = `🔧 ${entry.title} — ${status}`
  state.agentEntry = null // later agent text starts a new bubble
}

function renderUpdate(update) {
  if (!isObject(update)) return
  const kind = asText(update.sessionUpdate)
  if (kind === 'agent_message_chunk' && isObject(update.content) && update.content.type === 'text') {
    state.agentEntry ??= addEntry('agent', '')
    state.agentEntry.textContent += asText(update.content.text)
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    renderToolCall(update)
  }
}

// ---- permission prompts -------------------------------------------------

function describeToolCall(toolCall) {
  if (!isObject(toolCall)) return { title: 'unknown tool', kind: 'not provided by the agent', detail: '' }
  const detail = {}
  for (const key of ['rawInput', 'locations', 'content']) {
    if (toolCall[key] !== undefined) detail[key] = toolCall[key]
  }
  return {
    title: asText(toolCall.title) || 'unknown tool',
    // Kiro omits `kind` today, so judge the request by the exact input below, not this label
    kind: asText(toolCall.kind) || 'not provided by the agent',
    detail: JSON.stringify(detail, null, 2),
  }
}

function answerPermission(outcome) {
  const active = state.activePermission
  if (!active) return
  clearInterval(active.timer)
  state.activePermission = null
  send({ jsonrpc: '2.0', id: active.id, result: { outcome } })
  addEntry('system', outcome.outcome === 'selected' ? `Permission answered: ${active.labels.get(outcome.optionId)}` : 'Permission cancelled')
  ui.dialog.close()
  setAwaitingApproval(false)
  showNextPermission()
}

function rejectActivePermission() {
  const active = state.activePermission
  if (!active) return
  const reject = active.options.find((o) => o.kind === 'reject_once') ?? active.options.find((o) => o.kind === 'reject_always')
  answerPermission(reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' })
}

function showNextPermission() {
  if (state.activePermission || state.permissionQueue.length === 0) return
  const { id, params } = state.permissionQueue.shift()
  // "Always" grants are refused by the bridge; never offer them.
  const options = (Array.isArray(params.options) ? params.options : [])
    .filter((o) => isObject(o) && typeof o.optionId === 'string' && o.kind !== 'allow_always')
  const described = describeToolCall(params.toolCall)
  ui.dialogTool.textContent = described.title
  ui.dialogKind.textContent = described.kind
  ui.dialogDetail.textContent = described.detail
  ui.dialogOptions.replaceChildren()

  const labels = new Map()
  // Reject options first so the default focus is the safe choice.
  const ordered = [...options].sort((a, b) => Number(a.kind.startsWith('allow')) - Number(b.kind.startsWith('allow')))
  for (const option of ordered) {
    const label = asText(option.name) || option.kind
    labels.set(option.optionId, label)
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (!option.kind.startsWith('allow')) button.className = 'reject'
    button.addEventListener('click', () => answerPermission({ outcome: 'selected', optionId: option.optionId }))
    ui.dialogOptions.append(button)
  }

  const deadline = Date.now() + state.permissionTimeoutMs
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    ui.dialogCountdown.textContent = `Rejected automatically in ${seconds}s if you do not choose.`
    if (seconds === 0) rejectActivePermission()
  }
  state.activePermission = { id, options, labels, timer: setInterval(tick, 1000) }
  tick()
  addEntry('system', `Permission requested: ${described.title}`)
  ui.dialog.showModal()
  ui.dialogOptions.querySelector('button')?.focus()
  setAwaitingApproval(true)
  notifier.notify('Kiro needs your approval', 'A tool call is waiting in the Kiro ACP bridge tab.', {
    tag: 'kiro-approval',
    requireInteraction: true,
  })
}

ui.dialog.addEventListener('cancel', (event) => {
  event.preventDefault() // Escape = reject, not "leave pending"
  rejectActivePermission()
})

// ---- inbound frames -----------------------------------------------------

function handleMessage(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  if (!isObject(message)) return
  const { id, method } = message

  if (typeof method === 'string' && id !== undefined) {
    if (method === PERMISSION_METHOD && isObject(message.params)) {
      state.permissionQueue.push({ id, params: message.params })
      showNextPermission()
    }
    return
  }
  if (typeof method === 'string') {
    if (method === 'session/update' && isObject(message.params)) renderUpdate(message.params.update)
    if (method === PERMISSION_TIMEOUT_METHOD) handlePermissionTimeout(message.params)
    if (method === BLOCKED_METHOD && isObject(message.params)) addEntry('error', `Blocked: ${asText(message.params.reason)}`)
    return
  }
  const pending = state.pending.get(id)
  if (!pending) return
  state.pending.delete(id)
  if (isObject(message.error)) pending.reject(new Error(asText(message.error.message) || 'Agent error'))
  else pending.resolve(message.result)
}

function handlePermissionTimeout(params) {
  const id = isObject(params) ? params.id : undefined
  state.permissionQueue = state.permissionQueue.filter((p) => p.id !== id)
  if (state.activePermission?.id === id) {
    clearInterval(state.activePermission.timer)
    state.activePermission = null
    ui.dialog.close()
    setAwaitingApproval(false)
    addEntry('system', 'Permission timed out and was rejected by the bridge')
    showNextPermission()
  }
}

// ---- connection and turns -----------------------------------------------

async function startSession() {
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'kiro-acp-bridge-web', version: '0.1.0' },
  })
  const session = await request('session/new', { cwd: state.workspace, mcpServers: [] })
  if (!isObject(session) || typeof session.sessionId !== 'string') throw new Error('Agent returned no sessionId')
  state.sessionId = session.sessionId
  state.sessionImages = 0
  setStatus(`Connected — session ${state.sessionId}`)
  setTurnActive(false)
  ui.prompt.focus()
}

function resetConnection(reason) {
  for (const { reject } of state.pending.values()) reject(new Error(reason))
  state.pending.clear()
  if (state.activePermission) clearInterval(state.activePermission.timer)
  state.activePermission = null
  state.permissionQueue = []
  if (ui.dialog.open) ui.dialog.close()
  setAwaitingApproval(false)
  takeAttachments() // attachments belong to the session that just ended
  const wasConnected = state.sessionId !== null
  state.ws = null
  state.sessionId = null
  setTurnActive(false)
  ui.connect.disabled = false
  setStatus(`Disconnected (${reason})`)
  if (wasConnected) notifier.notify('Kiro bridge disconnected', 'Reconnect from the Kiro ACP bridge tab.', { tag: 'kiro-disconnect' })
}

function connect(token) {
  setStatus('Connecting…')
  ui.connect.disabled = true
  const ws = new WebSocket(`ws://${location.host}/acp`, [APP_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`])
  state.ws = ws
  ws.addEventListener('open', () => {
    startSession().catch((err) => {
      addEntry('error', `Session start failed: ${err.message}`)
      ws.close()
    })
  })
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handleMessage(event.data)
  })
  ws.addEventListener('close', (event) => {
    resetConnection(event.reason || (event.code === 1006 ? 'refused or dropped — check the token' : `code ${event.code}`))
  })
}

ui.connectForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void notifier.ensurePermission() // inside the user gesture, so the browser may show its prompt
  const token = ui.token.value.trim()
  ui.token.value = '' // keep it out of the DOM once used
  if (token && !state.ws) connect(token)
})

// ---- image attachments --------------------------------------------------

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${Math.ceil(bytes / 1024)} KiB`
}

function removeAttachment(attachment) {
  URL.revokeObjectURL(attachment.previewUrl)
  state.attachments = state.attachments.filter((a) => a !== attachment)
  renderAttachments()
}

function renderAttachments() {
  const items = state.attachments.map((attachment) => {
    const li = document.createElement('li')
    const img = document.createElement('img')
    img.src = attachment.previewUrl
    img.alt = `Preview of ${attachment.name}`
    const caption = document.createElement('span')
    const resized = attachment.resized ? ', resized' : ''
    const format = attachment.mimeType.replace('image/', '').toUpperCase()
    caption.textContent = `${attachment.name} — ${format} ${attachment.width}×${attachment.height}, ${formatBytes(attachment.bytes)}${resized}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove'
    remove.setAttribute('aria-label', `Remove ${attachment.name}`)
    remove.addEventListener('click', () => removeAttachment(attachment))
    li.append(img, caption, remove)
    return li
  })
  ui.attachments.replaceChildren(...items)
}

function imageBudget() {
  const limits = state.imageLimits
  if (!limits) return 0
  const perPrompt = limits.maxPerPrompt - state.attachments.length
  const perSession = limits.maxPerSession - state.sessionImages - state.attachments.length
  return Math.max(0, Math.min(perPrompt, perSession))
}

async function addImages(files) {
  const limits = state.imageLimits
  if (!limits || !state.sessionId || state.turnActive) return
  for (const file of files) {
    if (imageBudget() === 0) {
      addEntry('error', `Image limit reached (${limits.maxPerPrompt} per prompt, ${limits.maxPerSession} per session)`)
      return
    }
    try {
      const prepared = await prepareImage(file, limits)
      state.attachments.push({ ...prepared, previewUrl: URL.createObjectURL(prepared.blob) })
      renderAttachments()
    } catch (err) {
      addEntry('error', err instanceof ImageRejected ? err.message : `${file.name}: ${err.message}`)
    }
  }
}

ui.images.addEventListener('change', () => {
  const files = [...(ui.images.files ?? [])]
  ui.images.value = ''
  void addImages(files)
})

ui.prompt.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  void addImages(files)
})

function takeAttachments() {
  const taken = state.attachments
  state.attachments = []
  for (const a of taken) URL.revokeObjectURL(a.previewUrl)
  renderAttachments()
  return taken
}

// ---- turns --------------------------------------------------------------

ui.promptForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = ui.prompt.value.trim()
  if (!text || !state.sessionId || state.turnActive) return
  ui.prompt.value = ''
  const images = takeAttachments()
  state.sessionImages += images.length
  const imageNote = images.map((i) => `\n📎 ${i.name} (${i.width}×${i.height}, ${formatBytes(i.bytes)})`).join('')
  addEntry('user', `${text}${imageNote}`)
  state.agentEntry = null
  setTurnActive(true)
  const prompt = [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }))]
  request('session/prompt', { sessionId: state.sessionId, prompt })
    .then((result) => {
      const stopReason = isObject(result) ? asText(result.stopReason) : 'done'
      addEntry('system', `Turn finished: ${stopReason}`)
      notifier.notify('Kiro finished', `Turn ended (${stopReason}).`, { tag: 'kiro-turn' })
    })
    .catch((err) => {
      // The bridge refused the prompt before Kiro saw it, so its images were never counted there either
      if (err.message.startsWith('Blocked by bridge policy')) state.sessionImages -= images.length
      addEntry('error', `Turn failed: ${err.message}`)
      notifier.notify('Kiro turn failed', 'See the Kiro ACP bridge tab for details.', { tag: 'kiro-turn' })
    })
    .finally(() => {
      state.agentEntry = null
      setTurnActive(false)
    })
})

ui.cancel.addEventListener('click', () => {
  if (state.sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: state.sessionId } })
  // ACP: a client that cancels a turn answers its open permission requests with "cancelled".
  for (const queued of state.permissionQueue) send({ jsonrpc: '2.0', id: queued.id, result: { outcome: { outcome: 'cancelled' } } })
  state.permissionQueue = []
  answerPermission({ outcome: 'cancelled' })
})

fetch('/config.json')
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
  .then((config) => {
    if (!isObject(config) || typeof config.workspace !== 'string') throw new Error('bad config')
    state.workspace = config.workspace
    if (typeof config.permissionTimeoutMs === 'number') state.permissionTimeoutMs = config.permissionTimeoutMs
    ui.workspace.textContent = config.workspace
    const images = config.images
    if (isObject(images) && Array.isArray(images.mimeTypes) && typeof images.maxBase64Bytes === 'number') {
      state.imageLimits = images
      ui.imageLimits.textContent =
        `PNG, JPEG, GIF or WebP. Larger images are resized to ${images.maxDimension}px and compressed under ` +
        `${formatBytes(images.maxRawBytes)} as JPEG or ${formatBytes(images.maxRawBytesByType?.['image/png'] ?? images.maxRawBytes)} ` +
        `as PNG (Kiro re-encodes images; the model limit is 5 MiB of base64). ` +
        `Up to ${images.maxPerPrompt} per prompt and ${images.maxPerSession} per session.`
    }
  })
  .catch((err) => {
    ui.workspace.textContent = 'unavailable'
    ui.connect.disabled = true
    setStatus(`Bridge config failed to load: ${err.message}`)
  })
