/**
 * Shared state and helpers for the QA track s1 specs (s1-a-data.spec.ts, s1-b-assistant.spec.ts): the ten
 * `[e2e-qa]` comments, a state file that survives worker restarts, and a step
 * wrapper that also fails on console errors and records the Lambda window.
 *
 * The s1 specs run only with `E2E_TRACK=s1`: they write to production (one
 * manual import of exactly ten comments that cannot be deleted), so a normal
 * `npm run e2e:prod` never runs them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page, type TestInfo } from '@playwright/test'
import { test } from '../lib/test'
import { isRecord } from '../lib/guards'
import { E2E_PREFIX, OUT_DIR, RUN_ID, TRACK } from '../lib/env'
import { runStep } from '../lib/fixtures'
import { recordWindow } from '../lib/cloudwatch'
import type { StepRecorder } from '../lib/recorder'

/** The validated track tag from lib/env.ts (the same one RUN_ID and cleanup scoping use). */
export const S1_ENABLED = TRACK === 's1'

/** Skips unless E2E_TRACK=s1 and the project is `admin` (the user part opens its own context). */
export function s1Only(testInfo: TestInfo): void {
  test.skip(!S1_ENABLED, 'QA track s1 only (E2E_TRACK=s1): writes to production')
  test.skip(testInfo.project.metadata['role'] !== 'admin', 's1 drives both roles from the admin project')
}

export const NAME = {
  scraper: `${E2E_PREFIX}${RUN_ID}-scraper`,
  project: `${E2E_PREFIX}${RUN_ID}-chat-project`,
  userProject: `${E2E_PREFIX}${RUN_ID}-user-project`,
}

/** Manual-import source URL: its host becomes the feedback's `source_channel`. */
export const IMPORT_SOURCE_URL = 'https://e2e-qa/zebrafin-reviews'
export const IMPORT_CHANNEL = 'e2e-qa'
export const TEXT_PREFIX = '[e2e-qa]'

/** The ten comments; `key` is the distinctive phrase an answer must quote or paraphrase. */
export const COMMENTS: ReadonlyArray<{ key: string; text: string }> = [
  { key: 'pH sensor', text: '[e2e-qa] Zebrafin smart aquarium: the pH sensor drifts by 0.8 after two days, so the readings are useless.' },
  { key: 'logged out', text: '[e2e-qa] The Zebrafin app logged me out every 15 minutes and I had to re-pair the hub each time.' },
  { key: 'rattl', text: '[e2e-qa] The Zebrafin filter pump makes a loud rattling noise at night and wakes up my kids.' },
  { key: '9 days', text: '[e2e-qa] Zebrafin customer support took 9 days to answer my warranty claim.' },
  { key: 'sunrise', text: '[e2e-qa] I love the Zebrafin LED sunrise mode, my fish are calmer. Best feature by far.' },
  { key: 'feeder', text: '[e2e-qa] The Zebrafin auto-feeder jammed and dumped the whole pellet cartridge into the tank.' },
  { key: 'firmware', text: '[e2e-qa] Zebrafin firmware 3.2 bricked my controller and the rollback button does nothing.' },
  { key: 'shipping', text: '[e2e-qa] Shipping for my Zebrafin starter kit was fast and the box was well padded.' },
  { key: '24 euros', text: '[e2e-qa] The Zebrafin replacement cartridge subscription costs 24 euros a month, which is far too expensive.' },
  { key: 'temperature', text: '[e2e-qa] Zebrafin temperature alerts arrive 40 minutes late; my heater failed and I only found out hours later.' },
]

/** A comment's text after the `[e2e-qa] ` prefix: what pages and tool results show verbatim. */
export const snippet = (text: string): string => text.slice(TEXT_PREFIX.length + 1, TEXT_PREFIX.length + 52)

/** Looser stems for judging an LLM answer (it paraphrases). */
export const ANSWER_STEMS: readonly string[] = [
  'pH', 'log', 'rattl', 'noise', 'support', 'warranty', 'sunrise', 'LED', 'feeder', 'jam', 'firmware', 'brick',
  'shipping', 'subscription', 'expensive', '24', 'temperature', 'alert', 'heater', 'pump',
]

export interface ImportedItem {
  feedbackId: string
  key: string
  sentiment: string
  category: string
  /** confirm click → first API poll that returned it enriched. */
  apiVisibleMs: number
  /** confirm click → the processor's `processed_at`. */
  processedMs: number | null
  /** confirm click → its /feedback/{id} page showed the text. */
  uiVisibleMs?: number
}

export interface S1State {
  scraperId?: string
  importParseJobId?: string
  /** Set BEFORE the confirm click: a second run must never import again. */
  importAttemptedAt?: string
  importConfirmedAtMs?: number
  importConfirmStatus?: number
  importedCount?: number
  items?: ImportedItem[]
  projectId?: string
  projectThreadId?: string
  projectThreadTitle?: string
  userProjectId?: string
  /** Free-text provenance notes kept with the numbers (e.g. a re-based latency). */
  latencyNote?: string
  /** JSON summary of a confirm that was refused before anything was enqueued. */
  firstConfirmAttempt?: string
}

const STATE_FILE = path.join(OUT_DIR, 's1-state.json')

const STRING_KEYS = ['scraperId', 'importParseJobId', 'importAttemptedAt', 'projectId', 'projectThreadId', 'projectThreadTitle', 'userProjectId', 'latencyNote', 'firstConfirmAttempt'] as const
const NUMBER_KEYS = ['importConfirmedAtMs', 'importConfirmStatus', 'importedCount'] as const

function isImportedItem(value: unknown): value is ImportedItem {
  return isRecord(value) && typeof value['feedbackId'] === 'string' && typeof value['key'] === 'string'
    && typeof value['apiVisibleMs'] === 'number'
}

/** The state file, field by field: a hand-edited or stale value of the wrong type is dropped. */
export function readState(): S1State {
  if (!fs.existsSync(STATE_FILE)) return {}
  const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (!isRecord(raw)) return {}
  const state: S1State = {}
  for (const key of STRING_KEYS) {
    const value = raw[key]
    if (typeof value === 'string') state[key] = value
  }
  for (const key of NUMBER_KEYS) {
    const value = raw[key]
    if (typeof value === 'number') state[key] = value
  }
  const items = raw['items']
  if (Array.isArray(items)) state.items = items.filter(isImportedItem)
  return state
}

export function writeState(patch: Partial<S1State>): S1State {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const next = { ...readState(), ...patch }
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2))
  return next
}

/**
 * One evidence step (admin, dark). Fails on the suite's usual problems plus
 * console errors (the QA brief's rule), and records its time window so the
 * final test can pull the `lambdas`' REPORT lines.
 */
export async function s1Step(
  page: Page,
  name: string,
  lambdas: string[],
  action: (r: StepRecorder) => Promise<void>,
  options: {
    soft?: boolean
    role?: 'admin' | 'user'
    audit?: boolean
    /**
     * API 4xx the step provokes on purpose (e.g. a foreign project's 404). The
     * browser logs each as a console error, which then must not fail the step;
     * only these exact paths are excused, and only with that status.
     */
    expected4xx?: { status: number; path: RegExp }
  } = {},
): Promise<void> {
  const startMs = Date.now()
  // audit:false where a modal must survive into the next step: the design audit presses Escape.
  const { record, problems } = await runStep({ page, role: options.role ?? 'admin', theme: 'dark', step: `s1-${name}`, action, audit: options.audit })
  // Call sites list short names (`metrics-api`); the window stores base names (`voc-metrics-api`).
  recordWindow({ step: `s1-${name}`, startMs, endMs: Date.now() + 2_000, lambdas: lambdas.map((l) => `voc-${l}`) })
  const expected = options.expected4xx
  const excused = expected === undefined
    ? 0
    : record.calls.filter((c) => c.status === expected.status && expected.path.test(c.path)).length
  const unexpected4xx = expected === undefined
    ? []
    : record.calls.filter((c) => c.status !== null && c.status >= 400 && c.status < 500 && !(c.status === expected.status && expected.path.test(c.path)))
  const resourceLine = expected === undefined ? null : `the server responded with a status of ${expected.status}`
  let budget = unexpected4xx.length === 0 ? excused : 0
  const consoleErrors = record.console
    .filter((c) => c.type === 'error')
    .filter((c) => {
      if (resourceLine === null || budget === 0 || !c.text.includes(resourceLine)) return true
      budget -= 1
      return false
    })
    .map((c) => `console: ${c.text.slice(0, 200)}`)
  const all = [...problems, ...consoleErrors]
  const message = `${name}: ${record.screenshot ?? ''}`
  if (options.soft === true) expect.soft(all, message).toEqual([])
  else expect(all, message).toEqual([])
}
