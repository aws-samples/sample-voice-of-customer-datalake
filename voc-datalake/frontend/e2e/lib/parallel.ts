/**
 * Which production specs may run side by side (5.61.00). The suite used to run every spec on one
 * worker, so a full run took hours unless sharded. Specs that only READ (or validate without
 * storing) share nothing and run in parallel projects (`admin-read`, `user-read`) with up to
 * `E2E_READ_WORKERS` workers; every spec that writes stays in the `admin` / `user` projects, one
 * worker at a time unless `E2E_WRITE_WORKERS` says otherwise (run-sharded.sh keeps its 2).
 *
 * A spec belongs here only when it creates, changes and deletes nothing on the deployment: no
 * ledger entry, no settings write, no assistant run (each run saves a conversation). The unit spec
 * `unit/parallel.spec.ts` re-reads every listed spec for write calls.
 */
export const READ_ONLY_SPEC_NAMES: readonly string[] = [
  'screens', 'api-sweep', 'prioritization-requests', 'request-counts', 'dashboard-data', 'error-states',
  // POST /workflows/validate stores nothing (README).
  'workflow-custom-arrows',
]

/** Matches a path of one of READ_ONLY_SPEC_NAMES (Playwright `testMatch` / `testIgnore`). */
export const READ_ONLY_SPECS = new RegExp(`(?:^|/)(?:${READ_ONLY_SPEC_NAMES.join('|')})\\.spec\\.ts$`)

const DEFAULT_READ_WORKERS = 4
const DEFAULT_WRITE_WORKERS = 1
const MAX_WORKERS = 16

/** A positive worker count from `env[name]`, else `fallback` (anything else is refused, not guessed). */
export function workerCount(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKERS) {
    throw new Error(`${name} must be a whole number from 1 to ${MAX_WORKERS} (got ${raw})`)
  }
  return value
}

export interface WorkerPlan { read: number; write: number; total: number }

/** Workers for the read-only projects, the writing projects, and the run as a whole. */
export function workerPlan(env: Readonly<Record<string, string | undefined>> = process.env): WorkerPlan {
  const read = workerCount(env, 'E2E_READ_WORKERS', DEFAULT_READ_WORKERS)
  const write = workerCount(env, 'E2E_WRITE_WORKERS', DEFAULT_WRITE_WORKERS)
  return { read, write, total: read + write }
}
