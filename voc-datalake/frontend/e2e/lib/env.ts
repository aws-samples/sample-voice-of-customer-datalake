/**
 * Environment for the production e2e suite. Every secret comes from env vars;
 * nothing here is ever logged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required env var ${name} (see e2e/README.md)`)
  }
  return value.trim()
}

export type Role = 'admin' | 'user'

/**
 * `E2E_MOCK=1`: the run drives the local dev mock (`PORT=… node mock-server.js` +
 * `VITE_API_ENDPOINT=… vite`), not a deployment. There is no login (a DEV build
 * without Cognito is an admin session), so direct API calls carry no token and
 * the e2e-user steps skip. This is the suite's ONE mock switch: nothing else
 * reads `E2E_MOCK` (pinned by unit/helpers.spec.ts).
 */
export const MOCK = process.env['E2E_MOCK'] === '1'

/**
 * The specs (tests/<name>.spec.ts) that model the dev mock as well as
 * production. Under `E2E_MOCK=1` playwright.config.ts runs only these, as the
 * admin (a spec may still skip what the mock cannot model, as `sharing` does);
 * the rest of the suite is production-only. The design track
 * (playwright.design.config.ts) has its own mock projects.
 */
export const MOCK_SPEC_NAMES: readonly string[] = [
  'error-states', 'memory', 'connect', 'request-counts', 'prioritization-requests', 'modals', 'sharing',
  's2-workflow-rebuild', 'prioritization', 'account', 'in-page-tabs', 'i18n-smoke', 'network',
  'concurrency', 'auth-session', 'assistant-notifications', 'flows-matrix', 'prototype-enlarge',
  // 5.35 coverage (COVERAGE.md): the 5.00–5.34 features.
  'participants', 'unsubscribe', 'feature-requests', 'feedback-boards', 'board', 'product-interview', 'workflow-history', 'radar',
  'decisions', 'persona-avatars', 'surfaces',
  // Issue #411: CSV dataset re-upload updates (writes feedback, so mock only).
  'csv-dataset-update',
]

/** Matches a path of one of `MOCK_SPEC_NAMES` (Playwright `testMatch`). */
export const MOCK_SPECS = new RegExp(`(?:^|/)(?:${MOCK_SPEC_NAMES.join('|')})\\.spec\\.ts$`)

export const ROLES: readonly Role[] = ['admin', 'user']

export function siteUrl(): string {
  return required('E2E_SITE').replace(/\/+$/, '')
}

export function apiUrl(): string {
  return required('E2E_API').replace(/\/+$/, '')
}

export function credentials(role: Role): { username: string; password: string } {
  return role === 'admin'
    ? { username: required('E2E_ADMIN_USER'), password: required('E2E_ADMIN_PASSWORD') }
    : { username: required('E2E_USER_USER'), password: required('E2E_USER_PASSWORD') }
}

// fileURLToPath, not URL.pathname: the latter keeps %20 for paths with spaces.
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** JSON step records, the API sweep and the summary land here. */
export const OUT_DIR = process.env['E2E_OUT'] ?? path.resolve(HERE, '..', 'e2e-output')

/** Screenshots. */
export const SCREENS_DIR = process.env['E2E_SCREENS'] ?? path.join(OUT_DIR, 'screens')

/**
 * Where the saved sessions of a run live: `E2E_AUTH_DIR`, else `<E2E_OUT>/.auth`, else `e2e/.auth`.
 * Following E2E_OUT keeps parallel runs (shards, tracks) from overwriting each other's sessions: each
 * run's setup writes its own `<role>.json`, and a spec never reads a session another run's setup rotated.
 */
export function authDirFor(env: Readonly<Record<string, string | undefined>>): string {
  const nonEmpty = (name: string): string | null => {
    const value = env[name]?.trim()
    return value === undefined || value === '' ? null : value
  }
  const explicit = nonEmpty('E2E_AUTH_DIR')
  if (explicit !== null) return path.resolve(explicit)
  const out = nonEmpty('E2E_OUT')
  if (out !== null) return path.resolve(out, '.auth')
  return path.resolve(HERE, '..', '.auth')
}

/** Saved browser sessions (contain tokens; mode 700 / 600, gitignored, never print). */
export const AUTH_DIR = authDirFor(process.env)

/** Creates AUTH_DIR readable by the owner only (session files inside are written with mode 600). */
export function ensureAuthDir(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(AUTH_DIR, 0o700)
}

export function storageStatePath(role: Role): string {
  return path.join(AUTH_DIR, `${role}.json`)
}

/**
 * Whether the run's saved sessions are deleted when its cleanup finishes: yes for the default folders
 * (`<E2E_OUT>/.auth`, `e2e/.auth`), which belong to this run alone. Not when `E2E_AUTH_DIR` names a
 * folder (the caller owns it, e.g. shards sharing one) or `E2E_KEEP_AUTH=1` (re-running specs by hand).
 */
export function removesAuthAfterRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['E2E_AUTH_DIR'] ?? '').trim() === '' && env['E2E_KEEP_AUTH'] !== '1'
}

/** Deletes the run's saved sessions (Cognito tokens): nothing secret stays on disk after a run. */
export function removeAuthDir(): void {
  if (removesAuthAfterRun(process.env)) fs.rmSync(AUTH_DIR, { recursive: true, force: true })
}

/** Prefix of every entity this suite creates; cleanup only ever touches these. */
export const E2E_PREFIX = 'e2e-'

/** The built-in workflow: shared by every deployment, never archivable (its DELETE is a 409), never in a ledger. */
export const BUILTIN_WORKFLOW_ID = 'wf_default'

/** Optional QA track tag (`s1`, `s2`…): lower-case letters and digits only. */
export const TRACK = (() => {
  const raw = (process.env['E2E_TRACK'] ?? '').trim()
  if (raw === '') return null
  if (!/^[a-z][a-z0-9]{0,15}$/.test(raw)) throw new Error('E2E_TRACK must match ^[a-z][a-z0-9]{0,15}$')
  return raw
})()

/** `<epoch ms>`, or `<track>-<epoch ms>` when E2E_TRACK is set. */
export function defaultRunId(): string {
  return TRACK === null ? `${Date.now()}` : `${TRACK}-${Date.now()}`
}

/** Set once by playwright.config.ts and inherited by every worker. */
export const RUN_ID = process.env['E2E_RUN_ID'] ?? defaultRunId()

/** Every name this run creates starts with this (`e2e-<run id>-`). */
export const RUN_PREFIX = `${E2E_PREFIX}${RUN_ID}-`

/**
 * Names this suite created, for the OPT-IN leftover sweep (E2E_SWEEP_LEFTOVERS=1).
 * Without a track: `e2e-<epoch ms>-…` (a human's "e2e-demo" never matches).
 * With one: only `e2e-<track>-<epoch ms>-…`, so a sweep never reaches another
 * track's data.
 */
export const SUITE_NAME = TRACK === null
  ? new RegExp(`^${E2E_PREFIX}\\d{12,}-`)
  : new RegExp(`^${E2E_PREFIX}${TRACK}-\\d{12,}-`)
