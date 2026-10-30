/**
 * Every entity the suite creates is appended here the moment its id is known,
 * so cleanup can delete it even if a later step fails. Each entry carries the
 * run id that created it: the file may outlive a run (a reused E2E_OUT), and
 * cleanup deletes only this run's entries (`runLedger`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { isRecord } from './guards'
import { OUT_DIR, RUN_ID, RUN_PREFIX, type Role } from './env'
import { withFileLock } from './fileLock'

/** `token` is a global MCP token (`/connect/tokens`); `memory` and `token` are owned by `role`, like conversations. */
export const ENTITY_KINDS = ['project', 'feedback-form', 'scraper', 'conversation', 'agent', 'workflow', 'agent-run', 'memory', 'token', 'board'] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

const isEntityKind = (value: unknown): value is EntityKind => ENTITY_KINDS.some((kind) => kind === value)

export interface Created {
  kind: EntityKind
  id: string
  name: string
  at: string
  /** The run that created it (absent in entries written before run ids were recorded). */
  runId?: string
  /**
   * The user that owns it, when that is not the admin. Conversations live in
   * their creator's `USER#{sub}` partition, so only that user can delete them.
   */
  role?: Role
  /**
   * The spec file whose test recorded it (absent outside a test). A spec that cleans up
   * after itself deletes only its own entries (`specLedger`): 5.35.01 sharded e2e, s2-99
   * deleted s3's project mid-generation because both ran in one shard's ledger.
   */
  spec?: string
}

const FILE = path.join(OUT_DIR, 'created.json')

const isRole = (value: unknown): value is Role => value === 'admin' || value === 'user'

export function readLedger(): Created[] {
  if (!fs.existsSync(FILE)) return []
  const raw: unknown = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is Created =>
    isRecord(item) && isEntityKind(item['kind']) && typeof item['id'] === 'string' && typeof item['name'] === 'string'
    && (item['runId'] === undefined || typeof item['runId'] === 'string')
    && (item['role'] === undefined || isRole(item['role']))
    && (item['spec'] === undefined || typeof item['spec'] === 'string'))
}

/** The running test's spec file name (`s2-agents.spec.ts`), or undefined outside a test. */
export function currentSpec(): string | undefined {
  try {
    return path.basename(test.info().file)
  } catch {
    return undefined
  }
}

/** Is `entry` this run's own? Its recorded run id, or (legacy entries) a name under this run's prefix. */
export function isThisRun(entry: Created): boolean {
  return entry.runId === undefined ? entry.name.startsWith(RUN_PREFIX) : entry.runId === RUN_ID
}

/** The entries this run created (what cleanup may delete). */
export function runLedger(): Created[] {
  return readLedger().filter(isThisRun)
}

/**
 * The entries THIS spec file recorded in this run: what a spec's own cleanup may delete.
 * Other specs run beside it (workers, one ledger per shard), and their entities are
 * still in use; the shared teardown (tests/cleanup.spec.ts) takes the whole `runLedger`.
 */
export function specLedger(spec: string | undefined = currentSpec()): Created[] {
  return spec === undefined ? [] : runLedger().filter((e) => e.spec === spec)
}

/** Append an entry; one already recorded by this run (same kind and id) is not repeated. */
export function recordCreated(kind: EntityKind, id: string, name: string, role?: Role): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const spec = currentSpec()
  withFileLock(`${FILE}.lock`, () => {
    const ledger = readLedger()
    if (ledger.some((e) => e.kind === kind && e.id === id && e.runId === RUN_ID)) return
    const entry: Created = {
      kind, id, name, at: new Date().toISOString(), runId: RUN_ID,
      ...(role === undefined ? {} : { role }), ...(spec === undefined ? {} : { spec }),
    }
    // Write-then-rename: a reader never sees a half-written file.
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify([...ledger, entry], null, 2))
    fs.renameSync(`${FILE}.tmp`, FILE)
  })
}
