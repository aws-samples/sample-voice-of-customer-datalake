/**
 * An exclusive lock between processes, as a create-exclusive file (no dependencies, so a child
 * process can load this module on its own; unit/ledger-concurrency.spec.ts does).
 *
 * The workers of one shard share `created.json`. An unlocked read-modify-write let two concurrent
 * `recordCreated` calls drop an entry, and a dropped entry is prod data the teardown never deletes.
 * A lock older than STALE_MS (a killed worker) is taken over.
 */
import fs from 'node:fs'

const WAIT_MS = 10_000
const STALE_MS = 30_000
const POLL_MS = 25
const SLEEPER = new Int32Array(new SharedArrayBuffer(4))

function isExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

/** Run `fn` while holding the lock file `lockPath`. */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'))
      break
    } catch (error) {
      if (!isExists(error)) throw error
      const age = Date.now() - (fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > STALE_MS) fs.rmSync(lockPath, { force: true })
      else if (Date.now() > deadline) throw new Error(`lock ${lockPath} held for more than ${WAIT_MS} ms`)
      else Atomics.wait(SLEEPER, 0, 0, POLL_MS)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lockPath, { force: true })
  }
}
