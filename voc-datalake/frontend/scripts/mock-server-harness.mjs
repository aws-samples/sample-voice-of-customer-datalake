/**
 * Boots the dev mock (mock-server.js) on a free port for a node:test file, like check-mock-coverage.mjs.
 *
 *   const mock = useMockServer()          // at the top of a test file: starts before, stops after
 *   await fetch(`${mock.base}/feedback`)
 */

import { spawn } from 'node:child_process'
import { after, before } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort } from './check-mock-coverage.mjs'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..')
const START_TIMEOUT_MS = 20_000
const READY_LINE = 'Mock API server running'

/** The running mock's base URL and a `stop()` that ends it. Rejects when it does not start in time. */
export async function startMockServer() {
  const port = await freePort()
  const child = spawn(process.execPath, ['mock-server.js'], {
    cwd: FRONTEND, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'ignore'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), START_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(READY_LINE)) { clearTimeout(timer); resolve() }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`mock server exited ${code}`)) })
  })
  return { base: `http://127.0.0.1:${port}`, stop: () => { child.kill() } }
}

/** Registers before/after hooks that run the mock for the calling test file; `base` is set once it is up. */
export function useMockServer() {
  const server = { base: '' }
  let mock
  before(async () => {
    mock = await startMockServer()
    server.base = mock.base
  })
  after(() => { mock?.stop() })
  return server
}
