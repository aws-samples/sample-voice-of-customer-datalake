// Scripted ACP agent for bridge tests. Speaks NDJSON JSON-RPC on stdio.
// Every frame it receives is echoed back as a `_fake/received` notification so
// tests can assert what the bridge actually forwarded.
import { createInterface } from 'node:readline'

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const waiting = new Map() // our request id -> resolve
let nextId = 1000

function askPermission(sessionId, command) {
  const id = nextId++
  write({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: `call-${id}`, title: `Running: ${command}`, kind: 'execute', rawInput: { command } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  })
  return new Promise((resolve) => waiting.set(id, resolve))
}

async function handlePrompt(message) {
  const { sessionId, prompt } = message.params
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('')
  if (text === 'probe-huge-line') {
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, padding: 'x'.repeat(2 * 1024 * 1024) } })
    return
  }
  if (text === 'probe-fs') {
    // A client-side method the bridge must answer itself
    const id = nextId++
    write({ jsonrpc: '2.0', id, method: 'fs/read_text_file', params: { sessionId, path: '/etc/hosts' } })
    const reply = await new Promise((resolve) => waiting.set(id, resolve))
    write({ jsonrpc: '2.0', method: '_fake/fs_reply', params: reply })
  } else {
    const answer = await askPermission(sessionId, text)
    const outcome = answer.result?.outcome
    const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow-once'
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: allowed ? `executed: ${text}` : `denied: ${outcome?.optionId ?? outcome?.outcome}` },
        },
      },
    })
  }
  write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  write({ jsonrpc: '2.0', method: '_fake/received', params: message })
  if (message.method === undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
    return
  }
  if (message.method === 'initialize') {
    write({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (message.method === 'session/new') {
    write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-fake' } })
  } else if (message.method === 'session/prompt') {
    void handlePrompt(message)
  }
})
