// Live end-to-end check against the real `kiro-cli acp` (needs a logged-in kiro-cli).
// Not part of `npm test`: it calls the model and takes 10–60 s.
//
//   npm run e2e:kiro
//
// It starts the bridge on a throwaway workspace, connects exactly like the page
// (same Origin, token in Sec-WebSocket-Protocol), sends work, approves each tool
// call once, and asserts that the work ran on this machine (a file the agent wrote
// exists with the expected content) and that a reply came back.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { deflateSync, crc32 } from 'node:zlib'
import { startBridge } from '../src/bridge.mjs'

/** Minimal valid RGB PNG filled with one colour (zlib.crc32 needs Node 20.15+/22.2+). */
function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

const TURN_TIMEOUT_MS = 180_000
const marker = `kiro-acp-bridge-ok-${Date.now()}`
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'acp-bridge-e2e-')))
const proofFile = join(workspace, 'proof.txt')

const bridge = await startBridge({ workspaceRoots: [workspace], port: 0, permissionTimeoutMs: 60_000 })
const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/acp`, ['acp.v1', `acp-token.${bridge.token}`], {
  origin: `http://127.0.0.1:${bridge.port}`,
})

let nextId = 1
const pending = new Map()
const permissions = []
let reply = ''

function request(method, params) {
  const id = nextId++
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

ws.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.method === 'session/request_permission') {
    const allow = message.params.options.find((o) => o.kind === 'allow_once')
    permissions.push({ title: message.params.toolCall?.title, kinds: message.params.options.map((o) => o.kind) })
    console.log(`  permission: ${message.params.toolCall?.title ?? '?'} → allow_once`)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } }))
    return
  }
  if (message.method === 'session/update') {
    const update = message.params.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') reply += update.content.text
    return
  }
  if (message.method === '_bridge/blocked') console.log(`  blocked notification: ${message.params.reason}`)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`))
    else resolve(message.result)
  }
})

const timeout = setTimeout(() => {
  console.error('E2E timed out')
  process.exit(1)
}, TURN_TIMEOUT_MS)

try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'kiro-acp-bridge-e2e', version: '0.1.0' },
  })
  console.log(`initialize ok (protocolVersion ${init.protocolVersion})`)
  const { sessionId } = await request('session/new', { cwd: workspace, mcpServers: [] })
  console.log(`session ${sessionId}`)

  const prompt =
    `Use your shell tool to run exactly this command in the current directory: ` +
    `echo ${marker} > proof.txt && cat proof.txt\n` +
    `Then reply with only the command's output.`
  const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
  console.log(`turn finished: ${result.stopReason}`)
  console.log(`reply: ${reply.trim()}`)

  assert.equal(result.stopReason, 'end_turn')
  assert.ok(permissions.length > 0, 'expected at least one permission prompt (tools must not be pre-trusted)')
  assert.ok(existsSync(proofFile), 'agent did not create proof.txt in the workspace')
  assert.equal(readFileSync(proofFile, 'utf8').trim(), marker)
  assert.ok(reply.includes(marker), 'reply did not contain the command output')
  console.log('E2E PASS: work sent over the bridge ran locally and the reply came back')

  // Image turn: a solid-colour PNG must reach the model (Kiro drops images it cannot send without an error)
  reply = ''
  const imageResult = await request('session/prompt', {
    sessionId,
    prompt: [
      { type: 'text', text: 'What single colour fills the attached image? Reply with one lowercase word, or "none" if no image is attached.' },
      { type: 'image', mimeType: 'image/png', data: solidPng(64, 64, [0, 160, 0]).toString('base64') },
    ],
  })
  console.log(`image turn: ${imageResult.stopReason}, reply: ${reply.trim()}`)
  assert.match(reply.toLowerCase(), /green/, 'the model did not see the image')
  console.log('E2E PASS: an image sent over the bridge reached the model')
} finally {
  clearTimeout(timeout)
  ws.close()
  await bridge.close()
  rmSync(workspace, { recursive: true, force: true })
}
