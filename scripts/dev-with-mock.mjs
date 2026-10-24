#!/usr/bin/env node
/**
 * `npm run dev` from the repo root: the mock API (voc-datalake/frontend/mock-server.js,
 * http://localhost:3001 — the Vite `/api` proxy and the runtime-config fallback both
 * point there) and the Vite dev server, together in one terminal.
 *
 * - If something already listens on the mock port, it is reused rather than started
 *   twice (a second mock would exit with EADDRINUSE).
 * - Ctrl+C stops both; if either exits on its own, the other is stopped too.
 * - Extra arguments go to Vite: `npm run dev -- --port 5191`.
 *
 * Stdlib only, so it adds no dependency.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'voc-datalake', 'frontend')
const MOCK_PORT = Number(process.env.PORT ?? 3001)
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** Resolves true when a server already accepts connections on `port`. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

const children = []

function stopAll(code) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  process.exitCode = code
}

function start(label, args) {
  const child = spawn(NPM, args, { cwd: FRONTEND_DIR, stdio: 'inherit', env: process.env })
  child.on('exit', (code, signal) => {
    if (signal === null && code !== 0) console.error(`[dev] ${label} exited with code ${code}`)
    stopAll(code ?? 0)
  })
  child.on('error', (error) => {
    console.error(`[dev] could not start ${label}: ${error.message}`)
    stopAll(1)
  })
  children.push(child)
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopAll(0))

if (await portInUse(MOCK_PORT)) {
  console.log(`[dev] mock API already running on http://localhost:${MOCK_PORT} — reusing it`)
} else {
  console.log(`[dev] starting the mock API on http://localhost:${MOCK_PORT}`)
  start('mock API', ['run', 'mock'])
}
start('Vite', ['run', 'dev', '--', ...process.argv.slice(2)])
