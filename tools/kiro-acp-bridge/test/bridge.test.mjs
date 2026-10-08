import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { readLines, startBridge } from '../src/bridge.mjs'
import { b64, jpeg, png } from './fixtures/images.mjs'

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'acp-bridge-ws-')))

async function start(overrides = {}) {
  return startBridge({
    workspaceRoots: [workspace],
    port: 0,
    agentCommand: process.execPath,
    agentArgs: [FAKE_AGENT],
    log: () => {},
    ...overrides,
  })
}

/** Opens a socket the way the page does; returns a frame reader. */
function open(bridge, { token = bridge.token, origin = `http://127.0.0.1:${bridge.port}`, host, path = '/acp' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}${path}`, ['acp.v1', `acp-token.${token}`], {
    origin,
    headers: host ? { host } : {},
  })
  const frames = []
  const waiters = []
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString())
    frames.push(message)
    for (const w of [...waiters]) {
      if (w.match(message)) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(message)
      }
    }
  })
  const next = (match, timeoutMs = 3000) => {
    const found = frames.find(match)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve }
      waiters.push(waiter)
      setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs).unref()
    })
  }
  const send = (message) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
  return { ws, frames, next, send }
}

function rejectedStatus(client) {
  return new Promise((resolve, reject) => {
    client.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode))
    client.ws.on('open', () => reject(new Error('connection unexpectedly accepted')))
    client.ws.on('error', () => {})
  })
}

function httpGet(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function startSession(client) {
  await once(client.ws, 'open')
  client.send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { terminal: true } } })
  await client.next((m) => m.id === 1 && m.result)
  client.send({ id: 2, method: 'session/new', params: { cwd: workspace, mcpServers: [{ name: 'x', command: 'x' }] } })
  await client.next((m) => m.id === 2 && m.result)
}

const received = (client, method) => client.next((m) => m.method === '_fake/received' && m.params.method === method)

describe('bridge: network controls', () => {
  let bridge
  before(async () => (bridge = await start()))
  after(async () => bridge.close())

  it('refuses the upgrade without the token', async () => {
    assert.equal(await rejectedStatus(open(bridge, { token: '' })), 401)
  })

  it('refuses the upgrade with a wrong token', async () => {
    assert.equal(await rejectedStatus(open(bridge, { token: 'f'.repeat(64) })), 401)
  })

  it('refuses a cross-site Origin even with the right token', async () => {
    assert.equal(await rejectedStatus(open(bridge, { origin: 'https://evil.example' })), 403)
  })

  it('refuses a rebinding Host even with the right token and origin', async () => {
    assert.equal(await rejectedStatus(open(bridge, { host: `evil.example:${bridge.port}` })), 403)
  })

  it('refuses other upgrade paths', async () => {
    assert.equal(await rejectedStatus(open(bridge, { path: '/other' })), 404)
  })

  it('serves the page with a strict CSP', async () => {
    const res = await httpGet(bridge.port, '/')
    assert.equal(res.status, 200)
    assert.match(res.headers['content-security-policy'], /script-src 'self'/)
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })

  it('refuses HTTP requests with a foreign Host (DNS rebinding)', async () => {
    assert.equal((await httpGet(bridge.port, '/config.json', 'evil.example')).status, 403)
    assert.equal((await httpGet(bridge.port, '/', `evil.example:${bridge.port}`)).status, 403)
  })

  it('never serves files outside the fixed route table', async () => {
    assert.equal((await httpGet(bridge.port, '/../src/bridge.mjs')).status, 404)
    assert.equal((await httpGet(bridge.port, '/%2e%2e/package.json')).status, 404)
  })

  it('exposes the workspace but not the token in config.json', async () => {
    const res = await httpGet(bridge.port, '/config.json')
    assert.equal(JSON.parse(res.body).workspace, workspace)
    assert.equal(res.body.includes(bridge.token), false)
  })
})

describe('bridge: sessions', () => {
  it('runs a prompt end to end when the human allows the tool', async () => {
    const bridge = await start()
    try {
      const client = open(bridge)
      await startSession(client)

      const init = await received(client, 'initialize')
      assert.deepEqual(init.params.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false })
      const sessionNew = await received(client, 'session/new')
      assert.deepEqual(sessionNew.params.params.mcpServers, [])

      client.send({ id: 3, method: 'session/prompt', params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'echo hi' }] } })
      const permission = await client.next((m) => m.method === 'session/request_permission')
      client.send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })

      const chunk = await client.next((m) => m.method === 'session/update')
      assert.equal(chunk.params.update.content.text, 'executed: echo hi')
      assert.deepEqual((await client.next((m) => m.id === 3)).result, { stopReason: 'end_turn' })
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('blocks a forbidden method and tells the page why', async () => {
    const bridge = await start()
    try {
      const client = open(bridge)
      await startSession(client)
      client.send({ id: 4, method: '_kiro/settings/set', params: { trust: 'all' } })
      const reply = await client.next((m) => m.id === 4)
      assert.match(reply.error.message, /not allowed/)
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('does not let the page grant allow_always', async () => {
    const bridge = await start({ permissionTimeoutMs: 200 })
    try {
      const client = open(bridge)
      await startSession(client)
      client.send({ id: 3, method: 'session/prompt', params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'rm -rf x' }] } })
      const permission = await client.next((m) => m.method === 'session/request_permission')
      client.send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-always' } } })
      // The forged answer is dropped, so the bridge's timeout rejects instead
      await client.next((m) => m.method === '_bridge/permission_timeout')
      const chunk = await client.next((m) => m.method === 'session/update')
      assert.equal(chunk.params.update.content.text, 'denied: reject-once')
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('rejects an unanswered permission request after the timeout', async () => {
    const bridge = await start({ permissionTimeoutMs: 100 })
    try {
      const client = open(bridge)
      await startSession(client)
      client.send({ id: 3, method: 'session/prompt', params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'ls' }] } })
      await client.next((m) => m.method === 'session/request_permission')
      const chunk = await client.next((m) => m.method === 'session/update')
      assert.equal(chunk.params.update.content.text, 'denied: reject-once')
      // A late answer after the timeout is dropped, not forwarded
      const lateId = (await client.next((m) => m.method === 'session/request_permission')).id
      client.send({ id: lateId, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
      await delay(100)
      assert.equal(client.frames.some((m) => m.method === '_fake/received' && m.params.id === lateId && m.params.result?.outcome?.optionId === 'allow-once'), false)
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('answers client-side fs requests itself without involving the page', async () => {
    const bridge = await start()
    try {
      const client = open(bridge)
      await startSession(client)
      client.send({ id: 3, method: 'session/prompt', params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'probe-fs' }] } })
      const reply = await client.next((m) => m.method === '_fake/fs_reply')
      assert.equal(reply.params.error.code, -32601)
      assert.equal(client.frames.some((m) => m.method === 'fs/read_text_file'), false)
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('allows one browser connection at a time', async () => {
    const bridge = await start()
    try {
      const first = open(bridge)
      await once(first.ws, 'open')
      assert.equal(await rejectedStatus(open(bridge)), 409)
      first.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('kills the agent when the browser disconnects and accepts a new connection', async () => {
    const bridge = await start()
    try {
      const first = open(bridge)
      await startSession(first)
      const pid = bridge.agentPid()
      assert.equal(typeof pid, 'number')
      first.ws.close()
      await once(first.ws, 'close')
      await delay(200)
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })

      const second = open(bridge)
      await startSession(second)
      second.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('closes the socket when the agent command cannot start', async () => {
    const bridge = await start({ agentCommand: join(workspace, 'no-such-agent') })
    try {
      const client = open(bridge)
      await once(client.ws, 'open')
      const [code] = await once(client.ws, 'close')
      assert.equal(code, 1000)
    } finally {
      await bridge.close()
    }
  })

  it('refuses to start with auto-approve agent flags', async () => {
    await assert.rejects(start({ agentArgs: [FAKE_AGENT, '--trust-all-tools'] }), /must be approved/)
  })

  it('carries a near-limit image prompt (frames far above the old 1 MB cap) to the agent', async () => {
    const bridge = await start()
    try {
      const client = open(bridge)
      await startSession(client)
      const data = b64(jpeg(1600, 1200, 0xc0, 3_900_000))
      client.send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'describe' }, { type: 'image', mimeType: 'image/jpeg', data }] },
      })
      const prompt = await received(client, 'session/prompt')
      assert.equal(prompt.params.params.prompt[1].data.length, data.length)
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('tells the page why an oversized image was refused, and the agent never sees it', async () => {
    const bridge = await start()
    try {
      const client = open(bridge)
      await startSession(client)
      const data = b64(png(2400, 1200))
      client.send({
        id: 3,
        method: 'session/prompt',
        params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'x' }, { type: 'image', mimeType: 'image/png', data }] },
      })
      assert.match((await client.next((m) => m.id === 3)).error.message, /2400x1200px/)
      await delay(100)
      assert.equal(client.frames.some((m) => m.method === '_fake/received' && m.params.method === 'session/prompt'), false)
      client.ws.close()
    } finally {
      await bridge.close()
    }
  })

  it('closes the session when the agent emits a line over the cap', async () => {
    const bridge = await start({ maxAgentLineBytes: 1024 * 1024 })
    try {
      const client = open(bridge)
      await startSession(client)
      client.send({ id: 3, method: 'session/prompt', params: { sessionId: 'sess-fake', prompt: [{ type: 'text', text: 'probe-huge-line' }] } })
      const [, reason] = await once(client.ws, 'close')
      assert.match(reason.toString(), /line over 1048576 bytes/)
    } finally {
      await bridge.close()
    }
  })

  it('publishes the image limits in config.json', async () => {
    const bridge = await start()
    try {
      const { images } = JSON.parse((await httpGet(bridge.port, '/config.json')).body)
      assert.equal(images.maxBase64Bytes, 5_242_880)
      assert.equal(images.maxDimension, 2000)
      assert.deepEqual(images.mimeTypes, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    } finally {
      await bridge.close()
    }
  })

  it('serves the page modules and allows blob: previews only for images', async () => {
    const bridge = await start()
    try {
      for (const path of ['/images.js', '/notify.js']) assert.equal((await httpGet(bridge.port, path)).status, 200)
      const csp = (await httpGet(bridge.port, '/')).headers['content-security-policy']
      assert.match(csp, /img-src 'self' blob:;/)
      assert.match(csp, /script-src 'self';/)
    } finally {
      await bridge.close()
    }
  })
})

describe('readLines', () => {
  const collect = (chunks, maxLineBytes = 1024) => {
    const stream = new PassThrough()
    const lines = []
    let overflowed = false
    readLines(stream, { maxLineBytes, onLine: (l) => lines.push(l), onOverflow: () => (overflowed = true) })
    for (const chunk of chunks) stream.write(chunk)
    return { lines, overflowed: () => overflowed }
  }

  it('joins lines split across chunks, strips CRLF and skips blank lines', () => {
    const { lines } = collect([Buffer.from('{"a"'), Buffer.from(':1}\r\n\n{"b":2}\n')])
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  })

  it('decodes a multi-byte character split across chunks', () => {
    const bytes = Buffer.from('é\n')
    const { lines } = collect([bytes.subarray(0, 1), bytes.subarray(1)])
    assert.deepEqual(lines, ['é'])
  })

  it('reports overflow once and stops emitting', () => {
    const { lines, overflowed } = collect([Buffer.alloc(600, 0x61), Buffer.alloc(600, 0x61), Buffer.from('\nok\n')], 1000)
    assert.equal(overflowed(), true)
    assert.deepEqual(lines, [])
  })
})
