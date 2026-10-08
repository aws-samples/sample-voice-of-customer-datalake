/**
 * QA track s3 (admin, production, e2e-owned project only): personas with
 * avatars, persona import + avatar regeneration, assistant chat with personas
 * and documents, PRD / PR-FAQ generation (wizard + assistant), document edit
 * (editor + assistant approval), versions, remix, export, research, prototype
 * smoke, then delete the project and prove its avatars are gone from S3.
 *
 * Every job is followed through GET /projects/{id}/jobs/{job_id} (each poll
 * recorded) while the page keeps its own jobs polling (captured by the step
 * recorder); Lambda REPORT lines for each job window come from CloudWatch.
 * Run alone: `npx playwright test -c playwright.config.ts --project=admin --no-deps tests/s3-personas-documents.spec.ts`
 * (--no-deps also skips the shared cleanup teardown, which sweeps every track's
 * e2e-* data; this spec deletes and proves its own project instead).
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page, type Response } from '@playwright/test'
import { test } from '../lib/test'
import { saveSession } from '../lib/context'
import { dialogNamed } from '../lib/dialogs'
import { apiCall, listOf, stringField } from '../lib/api'
import { askAssistant, type AssistantTurn } from '../lib/assistant'
import { LOG_LAG_PAD_MS, logLines, reportLines, scrubTokens } from '../lib/cloudwatch'
import { E2E_PREFIX, OUT_DIR, RUN_ID, apiUrl } from '../lib/env'
import { escapeRegExp, jsonOf, runStep, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { followJob, type JobTrace } from '../lib/jobs'
import { readLedger, recordCreated } from '../lib/ledger'
import { avatarKeyOfUrl, existingAvatarKeys } from '../lib/avatars'
import { deleteConversations, runConversations } from '../lib/runCleanup'
import type { StepRecorder } from '../lib/recorder'

const PROJECT = `${E2E_PREFIX}${RUN_ID}-s3-project`
const PRD_TITLE = `${E2E_PREFIX}${RUN_ID}-s3 Saved filters`
/** Step 03c's own persona (created through the API, edited and deleted in the UI). */
const CRUD_PERSONA = 'Casey Lindqvist'
const CRUD_TAGLINE = 'Edited by the e2e suite'
/** The deployment's raw-data bucket (voc-raw-data-<account>-<region>); required for the S3 avatar proof. */
const RAW_BUCKET = process.env['E2E_RAW_BUCKET'] ?? ''
const JOB_TIMEOUT_MS = 14 * 60_000
const ASSISTANT_TIMEOUT_MS = 240_000
const EVIDENCE = path.join(OUT_DIR, 's3')

/** Lambdas each job kind touches (base names, see lib/utils/function-names.ts). */
const LAMBDAS = {
  personas: ['voc-job-persona-generator', 'voc-projects-api'],
  import: ['voc-job-persona-importer', 'voc-projects-api'],
  document: ['voc-job-document-generator', 'voc-projects-api'],
  merge: ['voc-job-document-merger', 'voc-projects-api'],
  research: ['voc-research-step', 'voc-projects-api'],
  chat: ['voc-chat-stream', 'voc-projects-api', 'voc-metrics-api', 'voc-chat-api'],
} as const

/** Lambdas whose REPORT lines belong to each step (step-name prefix -> base names). */
const STEP_LAMBDAS: Record<string, readonly string[]> = {
  '02-personas-generate': LAMBDAS.personas,
  '03-persona-import': LAMBDAS.import,
  '03b-avatar-regenerate': ['voc-projects-api'],
  '03c-persona-create': ['voc-projects-api'],
  '03d-persona-edit': ['voc-projects-api'],
  '03e-persona-delete': ['voc-projects-api'],
  '04-docs-wizard': LAMBDAS.document,
  '05a-assistant-personas': LAMBDAS.chat,
  '05b-assistant-document-qa': LAMBDAS.chat,
  '06-assistant-generate-document': [...LAMBDAS.chat, 'voc-job-document-generator'],
  '07a-editor-edit': ['voc-projects-api'],
  '07b-assistant-update-document': LAMBDAS.chat,
  '07c-versions-compare-restore': ['voc-projects-api'],
  '08-remix': LAMBDAS.merge,
  '10-research': LAMBDAS.research,
  '12-delete-and-sweep': ['voc-projects-api'],
}

// ---------------------------------------------------------------- state ----

interface S3State {
  personaIds: string[]
  documents: Record<string, string>
}

const STATE_FILE = path.join(EVIDENCE, 'state.json')

function readState(): S3State {
  if (!fs.existsSync(STATE_FILE)) return { personaIds: [], documents: {} }
  const raw: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (!isRecord(raw)) return { personaIds: [], documents: {} }
  const ids = Array.isArray(raw['personaIds']) ? raw['personaIds'].filter((v): v is string => typeof v === 'string') : []
  const docs: Record<string, string> = {}
  if (isRecord(raw['documents'])) {
    for (const [k, v] of Object.entries(raw['documents'])) if (typeof v === 'string') docs[k] = v
  }
  return { personaIds: ids, documents: docs }
}

function writeState(next: Partial<S3State>): void {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const current = readState()
  const merged: S3State = {
    personaIds: [...new Set([...current.personaIds, ...(next.personaIds ?? [])])],
    documents: { ...current.documents, ...(next.documents ?? {}) },
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2))
}

/** Extra evidence for a step (job traces, REPORT lines, avatar checks), scrubbed of tokens. */
function evidence(step: string, data: unknown): string {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const file = path.join(EVIDENCE, `${step}.json`)
  fs.writeFileSync(file, scrubTokens(JSON.stringify(data, null, 2)))
  return file
}

const projectId = (): string | undefined => readLedger().find((e) => e.kind === 'project' && e.name === PROJECT)?.id

// -------------------------------------------------------------- helpers ----

/** The accessible names of the dialogs this spec opens (found with `dialogNamed`, never by position). */
const DIALOG = {
  createProject: 'Create New Project',
  personas: 'Generate Personas',
  importPersona: 'Import Persona',
  editPersona: 'Edit Persona',
  // ProjectModals.tsx ConfirmModalWrapper (confirmDelete.personaTitle).
  deletePersona: 'Delete Persona?',
  // The wizard renames itself as types are toggled: Generate PRD / PR-FAQ / PRD + PR-FAQ.
  documents: /^Generate (PRD \+ PR-FAQ|PR-FAQ|PRD)$/,
  editDocument: 'Edit Document',
  remix: 'Remix Documents',
  research: 'Run Research',
  prototype: 'Build Prototype',
  deleteProject: 'Delete Project',
  // DocumentVersions.tsx: the restore ConfirmModal.
  restoreVersion: 'Restore this version?',
} as const satisfies Record<string, string | RegExp>

type DialogName = (typeof DIALOG)[keyof typeof DIALOG] | RegExp

const dialog = (page: Page, name: DialogName): Locator => dialogNamed(page, name)

/** DocumentVersions.tsx VersionDialog in compare mode: "v{n} compared with the current version". */
const versionDialogName = (n: number): RegExp => new RegExp(`^v${n} compared with the current version$`)

/** A Versions row's "Open v{n}" button (DocumentVersions.tsx openNamed): one per version. */
const OPEN_VERSION = /^Open v(\d+)$/

/** The version numbers of the open Versions list, in list order (newest first). */
async function versionLabels(page: Page): Promise<number[]> {
  const names = await page.getByRole('button', { name: OPEN_VERSION }).evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''))
  return names.map((name) => Number(OPEN_VERSION.exec(name)?.[1] ?? Number.NaN)).filter((n) => Number.isFinite(n))
}

/** Expands the selected document's Versions list if it is collapsed (it is by default, and after a remount). */
async function expandVersions(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Versions', exact: true }).first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

/** Expands the selected document's Versions list (collapsed by default) and waits for its rows. */
async function openVersions(page: Page): Promise<void> {
  await expandVersions(page)
  await expect(page.getByRole('button', { name: OPEN_VERSION }).first()).toBeVisible({ timeout: 20_000 })
}

/**
 * Waits until the Versions list, expanded, shows `version` first (newest first).
 *
 * QA 3.00.00 S2: after a Restore the SPA selects the restored document
 * (DocumentVersions.tsx `onSelectDoc`), which remounts the Versions section
 * COLLAPSED, at an unknown moment after the POST answered. Opening once and then
 * polling read the old expanded list, then a collapsed one (`undefined`) until
 * the timeout. Here each retry re-expands the list if the remount collapsed it,
 * then waits for the row web-first; no fixed sleeps.
 */
async function expectNewestVersion(page: Page, version: number): Promise<void> {
  await expect(async () => {
    await expandVersions(page)
    await expect(page.getByRole('button', { name: OPEN_VERSION }).first()).toHaveAccessibleName(`Open v${version}`, { timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

function isApi(response: Response, method: string, pattern: RegExp): boolean {
  const url = new URL(response.url())
  return response.request().method() === method && url.origin === new URL(apiUrl()).origin && pattern.test(url.pathname)
}


/** Type badge each Documents-tab entry starts with: a PRD and a PR-FAQ generated together share one title. */
const TYPE_BADGE: Record<string, string> = { prd: 'PRD', prfaq: 'PR.?FAQ' }

/** The Documents-tab list entry for `title` (and, when given, of that document type). */
const docButton = (page: Page, title: string, docType?: string): Locator => {
  const badge = docType === undefined ? '' : `^\\s*${TYPE_BADGE[docType] ?? docType}\\b.*`
  return page.getByRole('button', { name: new RegExp(`${badge}${escapeRegExp(title)}`, 'i') }).first()
}

async function step(page: Page, name: string, action: (r: StepRecorder) => Promise<void>): Promise<void> {
  const { record, problems } = await runStep({ page, role: 'admin', theme: 'dark', step: `s3-${name}`, audit: false, action })
  expect(problems, `${name}: ${record.screenshot ?? ''}`).toEqual([])
}

async function openTab(page: Page, tab: string): Promise<void> {
  await page.goto(site(`/projects/${projectId() ?? ''}?tab=${tab}`), { waitUntil: 'domcontentloaded' })
  await settle(page, 800)
  await persistSession(page)
}

/**
 * The SPA refreshes its Cognito tokens itself; writing its storage back keeps the
 * direct API calls (apiCall reads the saved session) valid past the 1 h id-token
 * lifetime of a long job-following run.
 */
async function persistSession(page: Page): Promise<void> {
  // Without the persisted UI: an assistant panel left open must not open in every later context.
  await saveSession(page.context(), 'admin')
}

/** Clicks Next through a DataSourceWizard until `submit` is visible, then clicks it. */
async function completeWizard(page: Page, name: DialogName, submit: RegExp, r: StepRecorder, fillFinal?: () => Promise<void>): Promise<void> {
  const wizard = dialog(page, name)
  for (let i = 0; i < 6; i += 1) {
    const submitButton = wizard.getByRole('button', { name: submit })
    if (await submitButton.isVisible().catch(() => false)) break
    const header = (await wizard.getByText(/Step \d+ of \d+/).first().innerText().catch(() => '')).trim()
    // Production feedback is older than the default "Last 30 days"; widen to a year where offered.
    const range = wizard.locator('select').filter({ has: page.locator('option', { hasText: 'Last year' }) })
    if (await range.count() > 0) {
      await range.first().selectOption({ label: 'Last year' })
      r.note(`wizard ${header}: time range -> Last year`)
    }
    r.note(`wizard ${header}: Next`)
    await wizard.getByRole('button', { name: 'Next', exact: true }).click()
    await page.waitForTimeout(400)
  }
  if (fillFinal) await fillFinal()
  await page.screenshot({ path: path.join(EVIDENCE, `wizard-final-${submit.source.replace(/\W+/g, '')}.png`) }).catch(() => undefined)
  await wizard.getByRole('button', { name: submit }).last().click()
}

/**
 * Whether the deployed sample walk can see any feedback. Before the fix in
 * shared/feedback.py (sample walk past empty days) it reads only the last 90
 * calendar days, so production feedback older than that is invisible to jobs.
 */
async function feedbackInSampleWindow(): Promise<boolean> {
  const res = await apiCall('admin', 'GET', '/feedback?days=90&limit=1')
  return isRecord(res.body) && typeof res.body['total'] === 'number' && res.body['total'] > 0
}

/** On the wizard's Data Sources step: ground on the project's personas instead of feedback the job cannot see. */
async function groundOnPersonasIfNoFeedback(page: Page, name: DialogName, r: StepRecorder): Promise<void> {
  if (await feedbackInSampleWindow()) return
  const wizard = dialog(page, name)
  const feedback = wizard.getByRole('checkbox', { name: /Customer Feedback/ })
  const personas = wizard.getByRole('checkbox', { name: /Personas \(/ })
  if (await feedback.isChecked().catch(() => false)) await feedback.uncheck()
  if (await personas.count() > 0 && !(await personas.isChecked())) await personas.check()
  r.note('no feedback in the deployed 90-day sample window: data source switched to Personas (see the feedback-walk finding)')
}

/** REPORT lines + interesting log lines for the Lambdas of one job window. */
function lambdaEvidence(bases: readonly string[], startMs: number, endMs: number, pattern?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const base of bases) {
    out[base] = {
      reports: reportLines(base, startMs, endMs + LOG_LAG_PAD_MS),
      ...(pattern === undefined ? {} : { lines: logLines(base, pattern, startMs, endMs, 80) }),
      errors: logLines(base, '?ERROR ?Exception ?Traceback ?AccessDenied ?"Task timed out"', startMs, endMs, 30),
    }
  }
  return out
}

/** UI polling calls of the jobs list the page made during the step. */
function uiJobPolls(r: StepRecorder): Array<{ status: number | null; ms: number | null }> {
  return r.callsSnapshot()
    .filter((c) => c.method === 'GET' && /\/projects\/[^/]+\/jobs$/.test(c.path))
    .map((c) => ({ status: c.status, ms: c.durationMs }))
}

interface AvatarCheck {
  personaId: string
  name: string
  hasUrl: boolean
  signed: boolean
  path: string
  httpStatus: number | null
  contentType: string | null
  bytes: number | null
  imgNaturalWidth: number | null
  rendered: 'img' | 'placeholder' | 'not-found'
}

/** Every persona of the project: signed CDN URL fetches 200 image/* and the <img> in the list decoded. */
async function checkAvatars(page: Page): Promise<AvatarCheck[]> {
  const res = await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`)
  const personas = listOf(res.body, 'personas')
  const checks: AvatarCheck[] = []
  for (const p of personas) {
    const url = stringField(p, 'avatar_url') ?? ''
    const name = stringField(p, 'name') ?? ''
    let httpStatus: number | null = null
    let contentType: string | null = null
    let bytes: number | null = null
    if (url !== '') {
      const img = await fetch(url)
      httpStatus = img.status
      contentType = img.headers.get('content-type')
      bytes = (await img.arrayBuffer()).byteLength
    }
    const imgLocator = page.locator(`img[alt="${name.replace(/"/g, '\\"')}"]`).first()
    const hasImg = await imgLocator.count() > 0
    const natural = hasImg ? await imgLocator.evaluate((el) => (el instanceof HTMLImageElement ? el.naturalWidth : 0)) : null
    const parsed = url === '' ? null : new URL(url)
    checks.push({
      personaId: stringField(p, 'persona_id') ?? '',
      name,
      hasUrl: url !== '',
      signed: parsed?.searchParams.has('Signature') ?? false,
      path: parsed?.pathname ?? '',
      httpStatus,
      contentType,
      bytes,
      imgNaturalWidth: natural,
      rendered: hasImg ? 'img' : (await page.getByText(name, { exact: true }).count()) > 0 ? 'placeholder' : 'not-found',
    })
  }
  return checks
}

/** `[PERSONA_AVATAR] Starting ...` -> `SUCCESS ...` per persona name, from the generator's log lines. */
function avatarDurations(lines: string[]): Array<{ persona: string; ms: number | null; outcome: string }> {
  const started = new Map<string, number>()
  const out: Array<{ persona: string; ms: number | null; outcome: string }> = []
  for (const line of lines) {
    const at = Date.parse(line.slice(0, 24))
    const start = /Starting avatar generation for ([^"\\]+?)(?:"|\\|$)/.exec(line)
    if (start?.[1] !== undefined) started.set(start[1].trim(), at)
    const ok = /SUCCESS - Avatar generated for ([^:]+):/.exec(line)
    if (ok?.[1] !== undefined) {
      const t0 = started.get(ok[1].trim())
      out.push({ persona: ok[1].trim(), ms: t0 === undefined ? null : at - t0, outcome: 'success' })
    }
    const failed = /(ACCESS DENIED|MODEL NOT AVAILABLE|VALIDATION ERROR|FAILED)[^"]{0,200}/.exec(line)
    if (failed !== null && !line.includes('SUCCESS')) out.push({ persona: '?', ms: null, outcome: failed[0].slice(0, 200) })
  }
  return out
}

/** Read-only S3 proof: the avatar objects of these personas that exist now (both key layouts, lib/avatars.ts). */
function avatarObjects(personaIds: string[]): string[] {
  if (RAW_BUCKET === '') throw new Error('Set E2E_RAW_BUCKET to the deployment raw-data bucket (voc-raw-data-<account>-<region>)')
  return existingAvatarKeys(RAW_BUCKET, personaIds)
}

/** Starts a job via `trigger` (which resolves to the POST response) and follows it to completion. */
async function runJob(r: StepRecorder, label: string, lambdas: readonly string[], trigger: () => Promise<Response>, pattern?: string): Promise<JobTrace> {
  const t0 = Date.now()
  const response = await trigger()
  const body = await jsonOf(response)
  const jobId = stringField(body, 'job_id') ?? ''
  r.note(`${label}: ${response.request().method()} ${new URL(response.url()).pathname} -> ${response.status()} in ${Date.now() - t0}ms job=${jobId}`)
  expect(response.status(), `${label} start`).toBeLessThan(300)
  expect(jobId, `${label} job id`).not.toBe('')
  const trace = await followJob('admin', projectId() ?? '', jobId, JOB_TIMEOUT_MS)
  const t1 = Date.now()
  r.note(`${label}: ${trace.finalStatus} queue-to-start<=${trace.queueToStartMs}ms total=${trace.totalMs}ms polls=${trace.polls.length} error=${trace.error ?? '-'}`)
  evidence(`job-${label}`, { window: { start: t0, end: t1 }, trace, uiJobPolls: uiJobPolls(r), lambdas: lambdaEvidence(lambdas, t0 - 5_000, t1, pattern) })
  expect(trace.finalStatus, `${label}: ${trace.error ?? ''}`).toBe('completed')
  return trace
}

async function documentsOf(): Promise<Array<Record<string, unknown>>> {
  const res = await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`)
  return listOf(res.body, 'documents')
}

function recordTurn(r: StepRecorder, label: string, turn: AssistantTurn): void {
  r.note(`${label}: /chat/stream ${turn.status} headers=${turn.headersMs}ms ttfb=${turn.ttfbMs}ms total=${turn.totalMs}ms run=${turn.runMs}ms approvals=${turn.approvals.length}`)
  r.note(`${label} answer: ${turn.answer.slice(0, 700).replace(/\s+/g, ' ')}`)
  if (turn.conversationId !== null) recordCreated('conversation', turn.conversationId, `${PROJECT} ${label}`)
}

// ---------------------------------------------------------------- tests ----

// Default mode, one worker: file order, and one failure does not skip the rest
// (each later test skips itself when the project it needs is missing).

test.describe('s3: personas, avatars, documents (admin, e2e project)', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.metadata['role'] !== 'admin', 'admin only')
  })

  test('01 create project', async ({ page }) => {
    await step(page, '01-project-create', async (r) => {
      if (projectId() !== undefined) {
        r.note(`reusing ${projectId() ?? ''}`)
        return
      }
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await page.getByRole('button', { name: /^(New Project|Create Project)$/ }).first().click()
      await dialog(page, DIALOG.createProject).getByLabel('Project Name').fill(PROJECT)
      await dialog(page, DIALOG.createProject).getByLabel('Description').fill('QA track s3: personas, avatars and documents. Deleted at the end of the run.')
      const created = page.waitForResponse((res) => isApi(res, 'POST', /\/projects$/))
      await dialog(page, DIALOG.createProject).getByRole('button', { name: 'Create Project' }).click()
      const response = await created
      const body = await jsonOf(response)
      const id = stringField(isRecord(body['project']) ? body['project'] : undefined, 'project_id', 'id')
      r.note(`POST /projects -> ${response.status()} id=${id ?? '?'}`)
      expect(response.status()).toBeLessThan(300)
      expect(id).toBeTruthy()
      if (id !== undefined) recordCreated('project', id, PROJECT)
    })
  })

  test('02 generate personas with avatars', async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 180_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '02-personas-generate', async (r) => {
      await openTab(page, 'personas')
      await page.getByRole('button', { name: 'Generate Personas', exact: true }).first().click()
      await expect(dialog(page, DIALOG.personas)).toBeVisible()
      const trace = await runJob(r, 'personas', LAMBDAS.personas, async () => {
        const posted = page.waitForResponse((res) => isApi(res, 'POST', /\/personas\/generate$/), { timeout: 60_000 })
        await completeWizard(page, DIALOG.personas, /^Generate Personas$/, r, async () => {
          await dialog(page, DIALOG.personas).locator('input[type="range"]').fill('3')
        })
        return posted
      }, '"PERSONA"')
      r.note(`persona job result: ${JSON.stringify(trace.result).slice(0, 300)}`)
      // The page polls the jobs list and refetches the project on completion.
      await expect(page.getByRole('heading', { name: 'No personas yet' })).toHaveCount(0, { timeout: 60_000 })
      await settle(page, 3_000)
      const checks = await checkAvatars(page)
      writeState({ personaIds: checks.map((c) => c.personaId) })
      const lines = logLines('voc-job-persona-generator', '"PERSONA_AVATAR"', Date.parse(trace.createdAt ?? '') - 5_000 || Date.now() - JOB_TIMEOUT_MS, Date.now(), 200)
      const file = evidence('02-avatars', { checks, avatarTimes: avatarDurations(lines), avatarLog: lines })
      r.note(`avatar checks (${file}): ${JSON.stringify(checks.map((c) => [c.name, c.httpStatus, c.contentType, c.imgNaturalWidth, c.rendered]))}`)
      expect(checks.length).toBeGreaterThan(0)
      for (const c of checks) {
        expect(c.hasUrl, `${c.name}: avatar_url`).toBe(true)
        expect(c.httpStatus, `${c.name}: CDN status`).toBe(200)
        expect(c.contentType ?? '', `${c.name}: content-type`).toMatch(/^image\//)
        expect(c.path, `${c.name}: path`).toMatch(/^\/avatars\//)
        expect(c.imgNaturalWidth ?? 0, `${c.name}: img decoded`).toBeGreaterThan(0)
      }
    })
  })

  test('03 import persona, regenerate one avatar', async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 180_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '03-persona-import', async (r) => {
      await openTab(page, 'personas')
      await page.getByRole('button', { name: 'Import Persona' }).first().click()
      await expect(dialog(page, DIALOG.importPersona)).toBeVisible()
      await dialog(page, DIALOG.importPersona).getByRole('button', { name: /Text/ }).first().click()
      await dialog(page, DIALOG.importPersona).getByLabel('Paste Persona Content').fill(
        'Persona: Priya Raman, 34, operations lead at a mid-size logistics company in Pune. '
        + 'Uses the product daily on a laptop and occasionally on mobile. Goals: fewer manual exports, '
        + 'reliable notifications, clear pricing. Frustrations: slow support replies, confusing billing changes, '
        + 'app crashes after updates. Quote: "I need it to just work on Monday mornings."')
      await runJob(r, 'import', LAMBDAS.import, async () => {
        const posted = page.waitForResponse((res) => isApi(res, 'POST', /\/personas\/import$/), { timeout: 60_000 })
        await dialog(page, DIALOG.importPersona).getByRole('button', { name: 'Import Persona', exact: true }).click()
        return posted
      }, '"PERSONA_AVATAR"')
      await openTab(page, 'personas')
      await expect(page.getByText('Priya Raman').first()).toBeVisible({ timeout: 60_000 })
      const checks = await checkAvatars(page)
      writeState({ personaIds: checks.map((c) => c.personaId) })
      const imported = checks.find((c) => c.name.includes('Priya'))
      r.note(`imported persona avatar: ${JSON.stringify(imported)}`)
      evidence('03-import-avatars', { checks })
      expect(imported?.httpStatus, 'imported persona avatar').toBe(200)
      expect(imported?.imgNaturalWidth ?? 0).toBeGreaterThan(0)
    })
    await step(page, '03b-avatar-regenerate', async (r) => {
      // No UI control exists for this route (finding); it is called as the SPA would, with the admin's token.
      const target = readState().personaIds[0] ?? ''
      const before = (await checkAvatars(page)).find((c) => c.personaId === target)
      const t0 = Date.now()
      const res = await apiCall('admin', 'POST', `/projects/${projectId() ?? ''}/personas/${encodeURIComponent(target)}/regenerate-avatar`, {})
      const t1 = Date.now()
      r.note(`POST .../personas/{id}/regenerate-avatar -> ${res.status} in ${res.ms}ms body=${scrubTokens(JSON.stringify(res.body)).replace(/\?[^"]*/g, '?<sig>').slice(0, 300)}`)
      await openTab(page, 'personas')
      const after = (await checkAvatars(page)).find((c) => c.personaId === target)
      evidence('03b-regenerate', { before, after, status: res.status, ms: res.ms, lambdas: lambdaEvidence(['voc-projects-api'], t0 - 2_000, t1, '"PERSONA_AVATAR"') })
      expect(res.status).toBe(200)
      expect(after?.httpStatus).toBe(200)
      expect(after?.imgNaturalWidth ?? 0).toBeGreaterThan(0)
    })
  })

  test('03c persona create, edit, delete (with its confirm)', async ({ page }) => {
    test.skip(projectId() === undefined, 'no project')
    // A persona of its own, deleted again here, so the later steps see the same personas.
    // Each step fails the test (step() asserts), so a later one never runs without the persona.
    let crudPersonaId = ''
    const listButton = page.getByRole('button', { name: new RegExp(`@${CRUD_PERSONA}`) }).first()
    const stored = async (): Promise<Record<string, unknown> | undefined> =>
      listOf((await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`)).body, 'personas').find((p) => p['persona_id'] === crudPersonaId)
    await step(page, '03c-persona-create', async (r) => {
      // No UI creates a blank persona (Import / Generate are the UI paths, steps 02-03); the route is the SPA client's createPersona.
      const res = await apiCall('admin', 'POST', `/projects/${projectId() ?? ''}/personas`, { name: CRUD_PERSONA, tagline: 'Created by the e2e suite' })
      const persona = isRecord(res.body) && isRecord(res.body['persona']) ? res.body['persona'] : undefined
      crudPersonaId = stringField(persona, 'persona_id') ?? ''
      r.note(`POST /projects/{id}/personas -> ${res.status} persona_id=${crudPersonaId}`)
      expect(res.status).toBe(200)
      expect(crudPersonaId).not.toBe('')
      await openTab(page, 'personas')
      await expect(listButton).toBeVisible()
    })
    await step(page, '03d-persona-edit', async (r) => {
      await listButton.click()
      await page.getByRole('button', { name: 'Edit persona', exact: true }).click()
      const edit = dialog(page, DIALOG.editPersona)
      await edit.getByLabel('Tagline').fill(CRUD_TAGLINE)
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', new RegExp(`/personas/${crudPersonaId}$`)))
      await edit.getByRole('button', { name: 'Save Changes' }).click()
      const status = (await saved).status()
      r.note(`PUT /projects/{id}/personas/{pid} -> ${status}`)
      expect(status).toBe(200)
      await expect(edit).toBeHidden()
      await expect(listButton).toContainText(CRUD_TAGLINE)
      expect(stringField(await stored(), 'tagline')).toBe(CRUD_TAGLINE)
    })
    await step(page, '03e-persona-delete', async (r) => {
      await openTab(page, 'personas')
      await listButton.click()
      const confirm = dialog(page, DIALOG.deletePersona)
      // Cancel first: the confirm must keep the persona.
      await page.getByRole('button', { name: 'Delete persona', exact: true }).click()
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(confirm).toBeHidden()
      expect(await stored(), 'still there after Cancel').toBeDefined()
      await page.getByRole('button', { name: 'Delete persona', exact: true }).click()
      const deleted = page.waitForResponse((res) => isApi(res, 'DELETE', new RegExp(`/personas/${crudPersonaId}$`)))
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
      const status = (await deleted).status()
      r.note(`DELETE /projects/{id}/personas/{pid} -> ${status}`)
      expect(status).toBe(200)
      await expect(listButton).toHaveCount(0)
      expect(await stored(), 'the persona is gone').toBeUndefined()
    })
  })

  test('04 PRD + PR-FAQ via the wizard', async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 240_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '04-docs-wizard', async (r) => {
      await openTab(page, 'overview')
      const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: /Generate PRD \/ PR-FAQ/ }) })
      await card.getByRole('button').first().click()
      await expect(dialog(page, DIALOG.documents)).toBeVisible()
      const posted: Response[] = []
      const listener = (res: Response): void => { if (isApi(res, 'POST', /\/projects\/[^/]+\/document$/)) posted.push(res) }
      page.on('response', listener)
      await groundOnPersonasIfNoFeedback(page, DIALOG.documents, r)
      await completeWizard(page, DIALOG.documents, /^Generate (PRD \+ PR-FAQ|PR-FAQ|PRD)$/, r, async () => {
        const wizard = dialog(page, DIALOG.documents)
        // PR-FAQ is preselected; add PRD so both generate at once.
        await wizard.getByRole('button', { name: /^PRD/ }).first().click()
        await wizard.getByPlaceholder('e.g., Real-time Delivery Tracking').fill(PRD_TITLE)
        await wizard.getByPlaceholder('Describe the feature...').fill('Let users save a set of feedback filters (source, category, sentiment, time range) and get a weekly digest of new matching feedback.')
      })
      await expect.poll(() => posted.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1)
      await page.waitForTimeout(3_000)
      page.off('response', listener)
      r.note(`POST /document x${posted.length}: ${posted.map((p) => p.status()).join(',')}`)
      // The two jobs run in parallel server-side; follow them in parallel so each queue-to-start is real.
      const traces: JobTrace[] = await Promise.all(posted.map((res, i) => runJob(r, `doc-${i}`, LAMBDAS.document, () => Promise.resolve(res))))
      r.note(`doc jobs: ${traces.map((t) => `${t.jobType} ${t.finalStatus} ${t.totalMs}ms`).join('; ')}`)
      await openTab(page, 'documents')
      const docs = await documentsOf()
      const generated = docs.filter((d) => ['prd', 'prfaq'].includes(stringField(d, 'document_type') ?? ''))
      for (const d of generated) {
        const content = stringField(d, 'content') ?? ''
        r.note(`doc ${stringField(d, 'document_type')} "${stringField(d, 'title')}" v=${String(d['version'])} chars=${content.length} head=${content.slice(0, 120).replace(/\s+/g, ' ')}`)
        expect(content.length, 'generated document has content').toBeGreaterThan(500)
      }
      const prd = generated.find((d) => stringField(d, 'document_type') === 'prd')
      const prfaq = generated.find((d) => stringField(d, 'document_type') === 'prfaq')
      writeState({ documents: { prd: stringField(prd, 'document_id') ?? '', prfaq: stringField(prfaq, 'document_id') ?? '' } })
      expect(prd, 'PRD persisted').toBeTruthy()
      expect(prfaq, 'PR-FAQ persisted').toBeTruthy()
      await expect(docButton(page, PRD_TITLE)).toBeVisible()
    })
  })

  test('05 assistant: consult personas, ask about a document', async ({ page }) => {
    test.setTimeout(2 * ASSISTANT_TIMEOUT_MS + 120_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '05a-assistant-personas', async (r) => {
      await openTab(page, 'personas')
      const t0 = Date.now()
      const turn = await askAssistant(page, 'Consult this project\'s personas: how would each of them react to a weekly email digest of new feedback? Quote each persona by name.', { timeoutMs: ASSISTANT_TIMEOUT_MS })
      recordTurn(r, 'personas', turn)
      evidence('05a-assistant-personas', { window: { start: t0, end: Date.now() }, turn, lambdas: lambdaEvidence(LAMBDAS.chat, t0, Date.now()) })
      expect(turn.status).toBe(200)
      const names = (await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`))
      const personaNames = listOf(names.body, 'personas').map((p) => (stringField(p, 'name') ?? '').split(' ')[0] ?? '')
      const mentioned = personaNames.filter((n) => n !== '' && turn.answer.includes(n))
      r.note(`personas named in the answer: ${mentioned.join(', ')} of ${personaNames.join(', ')}`)
      expect(mentioned.length, 'answer speaks for the personas').toBeGreaterThanOrEqual(Math.min(2, personaNames.length))
      expect(turn.answer, 'consult_personas ran').toMatch(/Consult personas/i)
    })
    await step(page, '05b-assistant-document-qa', async (r) => {
      const prdId = readState().documents['prd'] ?? ''
      const prd = (await documentsOf()).find((d) => stringField(d, 'document_id') === prdId)
      await openTab(page, 'documents')
      const t0 = Date.now()
      const turn = await askAssistant(page, `In the document "${stringField(prd, 'title') ?? PRD_TITLE}", what are the success metrics? Cite the document by its title.`, { timeoutMs: ASSISTANT_TIMEOUT_MS })
      recordTurn(r, 'doc-qa', turn)
      evidence('05b-assistant-doc-qa', { window: { start: t0, end: Date.now() }, turn, lambdas: lambdaEvidence(LAMBDAS.chat, t0, Date.now()) })
      expect(turn.status).toBe(200)
      expect(turn.answer, 'answer cites the document title').toContain(PRD_TITLE.split(' ')[0] ?? PRD_TITLE)
    })
  })

  test('06 assistant: generate a new PRD version (approval)', async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT_MS + ASSISTANT_TIMEOUT_MS + 120_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '06-assistant-generate-document', async (r) => {
      await openTab(page, 'documents')
      const before = new Set((await documentsOf()).map((d) => stringField(d, 'document_id') ?? ''))
      const t0 = Date.now()
      const turn = await askAssistant(page, `Generate a new PRD titled exactly "${PRD_TITLE}" for the same saved-filters digest feature, emphasising mobile push notifications. Use the generate document tool.`, { timeoutMs: ASSISTANT_TIMEOUT_MS, approveMax: 1 })
      recordTurn(r, 'generate', turn)
      expect(turn.approvals.length, 'an approval card was raised and approved').toBe(1)
      // The approved client tool starts a job; find it (the list is eventually consistent) and follow it.
      const findJob = async (): Promise<Record<string, unknown> | undefined> => {
        const jobs = await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}/jobs`)
        return listOf(jobs.body, 'jobs').find((j) => (stringField(j, 'job_type') ?? '').startsWith('generate_prd') && Date.parse(stringField(j, 'created_at') ?? '') >= t0 - 5_000)
      }
      await expect.poll(async () => (await findJob()) !== undefined, { timeout: 30_000 }).toBe(true)
      const job = await findJob()
      r.note(`job started by the assistant: ${stringField(job, 'job_id') ?? 'none'}`)
      expect(job).toBeTruthy()
      const trace = await followJob('admin', projectId() ?? '', stringField(job, 'job_id') ?? '', JOB_TIMEOUT_MS)
      r.note(`assistant PRD job ${trace.finalStatus} total=${trace.totalMs}ms queue<=${trace.queueToStartMs}ms`)
      evidence('06-assistant-generate', { window: { start: t0, end: Date.now() }, turn, trace, lambdas: lambdaEvidence([...LAMBDAS.chat, 'voc-job-document-generator'], t0, Date.now()) })
      expect(trace.finalStatus).toBe('completed')
      const fresh = (await documentsOf()).filter((d) => !before.has(stringField(d, 'document_id') ?? ''))
      r.note(`new documents: ${fresh.map((d) => `${stringField(d, 'title')} v${String(d['version'])}`).join('; ')}`)
      const v2 = fresh.find((d) => stringField(d, 'document_type') === 'prd')
      expect(v2, 'new PRD persisted').toBeTruthy()
      expect(Number(v2?.['version'] ?? 0), 'same base title allocates the next version').toBeGreaterThanOrEqual(2)
      writeState({ documents: { prdV2: stringField(v2, 'document_id') ?? '' } })
      // The previous version stays retrievable.
      const v1 = (await documentsOf()).find((d) => stringField(d, 'document_id') === readState().documents['prd'])
      expect((stringField(v1, 'content') ?? '').length, 'v1 still retrievable').toBeGreaterThan(500)
    })
  })

  test('07 edit: in-page editor, the assistant update with approval, then versions', async ({ page }) => {
    test.setTimeout(ASSISTANT_TIMEOUT_MS + 240_000)
    test.skip(projectId() === undefined, 'no project')
    const marker = `E2E-S3-EDIT-${RUN_ID}`
    await step(page, '07a-editor-edit', async (r) => {
      const docId = readState().documents['prfaq'] ?? ''
      const doc = (await documentsOf()).find((d) => stringField(d, 'document_id') === docId)
      const title = stringField(doc, 'title') ?? ''
      await openTab(page, 'documents')
      await docButton(page, title, 'prfaq').click()
      await page.getByRole('button', { name: 'Edit document' }).click()
      await expect(dialog(page, DIALOG.editDocument)).toBeVisible()
      const box = dialog(page, DIALOG.editDocument).getByLabel('Content (Markdown)')
      const original = await box.inputValue()
      await box.fill(`${original}\n\n## QA note\n\n${marker} (in-page editor)\n`)
      const saved = page.waitForResponse((res) => isApi(res, 'PUT', /\/documents\/[^/]+$/))
      await dialog(page, DIALOG.editDocument).getByRole('button', { name: 'Save Changes' }).click()
      const res = await saved
      r.note(`PUT /projects/{id}/documents/{doc} -> ${res.status()}`)
      expect(res.status()).toBeLessThan(300)
      await expect(page.getByText(marker).first()).toBeVisible({ timeout: 20_000 })
      // An edit is saved as the next version of the series: a NEW document (the PUT answers it).
      const savedDoc = (await jsonOf(res))['document']
      const editedId = stringField(isRecord(savedDoc) ? savedDoc : undefined, 'document_id') ?? docId
      const after = (await documentsOf()).find((d) => stringField(d, 'document_id') === editedId)
      expect(stringField(after, 'content') ?? '').toContain(marker)
      const previous = (await documentsOf()).find((d) => stringField(d, 'document_id') === docId)
      expect((stringField(previous, 'content') ?? '').length, 'the edited version stays retrievable').toBeGreaterThan(0)
      writeState({ documents: { prfaq: editedId } })
      r.note(`after edit: ${editedId} version=${String(after?.['version'])} (before ${docId} v${String(doc?.['version'])}); PR-FAQ documents: ${(await documentsOf()).filter((d) => stringField(d, 'document_type') === 'prfaq').length}`)
    })
    await step(page, '07b-assistant-update-document', async (r) => {
      const docId = readState().documents['prfaq'] ?? ''
      const doc = (await documentsOf()).find((d) => stringField(d, 'document_id') === docId)
      await openTab(page, 'documents')
      const t0 = Date.now()
      const turn = await askAssistant(page, `Update the PR-FAQ document "${stringField(doc, 'title') ?? ''}" (id ${docId}; not the PRD with the same title): append one final line that reads exactly "${marker}-assistant". Keep everything else unchanged. Use the update document tool.`, { timeoutMs: ASSISTANT_TIMEOUT_MS, approveMax: 1 })
      recordTurn(r, 'update', turn)
      evidence('07b-assistant-update', { window: { start: t0, end: Date.now() }, turn, lambdas: lambdaEvidence(LAMBDAS.chat, t0, Date.now()) })
      expect(turn.approvals.length, 'update_document needs approval').toBe(1)
      // The update is the series' next version, a new document: find it by its content.
      const updated = async (): Promise<Record<string, unknown> | undefined> => (await documentsOf())
        .find((d) => stringField(d, 'document_type') === 'prfaq' && (stringField(d, 'content') ?? '').includes(`${marker}-assistant`))
      await expect.poll(async () => (await updated()) !== undefined, { timeout: 30_000 }).toBe(true)
      const after = await updated()
      r.note(`assistant update: ${stringField(after, 'document_id') ?? '?'} v${String(after?.['version'])} (from ${docId})`)
      expect(stringField(after, 'content') ?? '', 'editor change kept').toContain(marker)
      if (after !== undefined) writeState({ documents: { prfaq: stringField(after, 'document_id') ?? docId } })
    })
    await step(page, '07c-versions-compare-restore', async (r) => {
      // s3 F4 (2.14): every edit is a version; Compare diffs one with the current; Restore adds vN+1.
      const docId = readState().documents['prfaq'] ?? ''
      const doc = (await documentsOf()).find((d) => stringField(d, 'document_id') === docId)
      await openTab(page, 'documents')
      await docButton(page, stringField(doc, 'title') ?? '', 'prfaq').click()
      await openVersions(page)
      const labels = await versionLabels(page)
      r.note(`Versions list: ${labels.map((n) => `v${n}`).join(', ')}`)
      // v1 (wizard), the editor edit, the assistant update: at least three, newest first.
      expect(labels.length, 'one version per edit').toBeGreaterThanOrEqual(3)
      expect(labels, 'newest first').toStrictEqual([...labels].sort((a, b) => b - a))
      const newest = labels[0] ?? 0
      const oldest = labels.at(-1) ?? 0

      await page.getByRole('button', { name: `Compare v${oldest} with the current version`, exact: true }).click()
      const compare = dialog(page, versionDialogName(oldest))
      await expect(compare).toBeVisible()
      const diff = (await compare.innerText()).trim()
      r.note(`Compare v${oldest}: ${diff.length} chars; head: ${diff.slice(0, 120).replace(/\s+/g, ' ')}`)
      expect(diff, 'v1 differs from the edited current version').not.toContain('This version is identical to the current one.')
      await compare.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(compare).toHaveCount(0)

      await page.getByRole('button', { name: `Restore v${oldest}`, exact: true }).click()
      const restored = page.waitForResponse((res) => isApi(res, 'POST', /\/versions\/[^/]+\/restore$/))
      await dialog(page, DIALOG.restoreVersion).getByRole('button', { name: 'Restore', exact: true }).click()
      const res = await restored
      r.note(`POST …/versions/{v${oldest}}/restore -> ${res.status()}`)
      expect(res.status()).toBeLessThan(300)
      await expectNewestVersion(page, newest + 1)
      await expect(page.getByText(`Restored from v${oldest}`, { exact: true }).first()).toBeVisible()
      const after = await versionLabels(page)
      r.note(`after restore: ${after.map((n) => `v${n}`).join(', ')} (current v${newest + 1}, restored from v${oldest})`)
      expect(after.length, 'restore adds a version, nothing is rewritten').toBe(labels.length + 1)
      const restoredDoc = await jsonOf(res)
      const restoredId = stringField(isRecord(restoredDoc['document']) ? restoredDoc['document'] : undefined, 'document_id')
      if (restoredId !== undefined) writeState({ documents: { prfaq: restoredId } })
    })
  })

  test('08 remix two documents', async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 180_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '08-remix', async (r) => {
      await openTab(page, 'overview')
      const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: /Remix Documents/ }) })
      await card.getByRole('button').first().click()
      await expect(dialog(page, DIALOG.remix)).toBeVisible()
      const wizard = dialog(page, DIALOG.remix)
      await page.screenshot({ path: path.join(EVIDENCE, 'remix-step1.png') })
      await runJob(r, 'merge', LAMBDAS.merge, async () => {
        const posted = page.waitForResponse((res) => isApi(res, 'POST', /\/documents\/merge$/), { timeout: 60_000 })
        // Step 1 Data Sources -> Next -> item selection: tick the PRD v1 and the PR-FAQ.
        for (let i = 0; i < 4; i += 1) {
          if (await wizard.getByRole('button', { name: /^Remix Documents$/ }).isVisible().catch(() => false)) break
          const checkboxes = wizard.getByRole('checkbox')
          const count = await checkboxes.count()
          r.note(`remix step ${(await wizard.getByText(/Step \d+ of \d+/).first().innerText().catch(() => '')).trim()}: ${count} checkboxes`)
          if (/Select Documents|Select Personas/.test(await wizard.innerText())) {
            const docs = wizard.getByRole('checkbox', { name: /PRD|PR-FAQ|Saved filters|e2e-/ })
            const n = await docs.count()
            for (let k = 0; k < Math.min(n, 2); k += 1) await docs.nth(k).check().catch(async () => docs.nth(k).click())
          }
          await page.screenshot({ path: path.join(EVIDENCE, `remix-step-${i + 2}.png`) })
          await wizard.getByRole('button', { name: 'Next', exact: true }).click()
          await page.waitForTimeout(400)
        }
        await wizard.getByRole('button', { name: 'PRD', exact: true }).click()
        await wizard.getByPlaceholder(/Virtual Concierge PRD/).fill(`${E2E_PREFIX}${RUN_ID}-s3 Remixed`)
        await wizard.getByPlaceholder('Describe how to remix...').fill('Combine both into one concise PRD. Keep the success metrics and the FAQ answers.')
        await page.screenshot({ path: path.join(EVIDENCE, 'remix-final.png') })
        await wizard.getByRole('button', { name: /^Remix Documents$/ }).click()
        return posted
      })
      const remixed = (await documentsOf()).find((d) => (stringField(d, 'title') ?? '').includes('Remixed'))
      r.note(`remixed: ${stringField(remixed, 'title')} chars=${(stringField(remixed, 'content') ?? '').length}`)
      expect((stringField(remixed, 'content') ?? '').length).toBeGreaterThan(300)
    })
  })

  test('09 export markdown, txt, pdf', async ({ page }) => {
    test.skip(projectId() === undefined, 'no project')
    await step(page, '09-export', async (r) => {
      const docId = readState().documents['prd'] ?? ''
      const doc = (await documentsOf()).find((d) => stringField(d, 'document_id') === docId)
      const title = stringField(doc, 'title') ?? ''
      await openTab(page, 'documents')
      await docButton(page, title, 'prd').click()
      for (const [item, ext] of [['Download as Markdown', 'md'], ['Download as TXT', 'txt']] as const) {
        await page.getByRole('button', { name: 'Download options' }).first().click()
        const download = page.waitForEvent('download')
        await page.getByRole('menuitem', { name: item }).or(page.getByRole('button', { name: item })).first().click()
        const file = await download
        const saved = path.join(EVIDENCE, `export.${ext}`)
        await file.saveAs(saved)
        const text = fs.readFileSync(saved, 'utf8')
        r.note(`${item}: ${file.suggestedFilename()} ${text.length} chars`)
        expect(text.length).toBeGreaterThan(500)
      }
      // PDF = hidden srcdoc iframe + print(), removed again after printing: capture the print
      // document as the frame is attached, then render it to a real PDF.
      await page.evaluate(() => {
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if (node instanceof HTMLIFrameElement && node.srcdoc !== '') Reflect.set(window, '__s3PrintDoc', node.srcdoc)
            }
          }
        }).observe(document.body, { childList: true })
      })
      await page.getByRole('button', { name: 'Download options' }).first().click()
      await page.getByRole('menuitem', { name: 'Download as PDF' }).or(page.getByRole('button', { name: 'Download as PDF' })).first().click()
      await expect.poll(() => page.evaluate(() => typeof Reflect.get(window, '__s3PrintDoc')), { timeout: 10_000 }).toBe('string')
      const srcdoc = await page.evaluate(() => String(Reflect.get(window, '__s3PrintDoc') ?? ''))
      const printPage = await page.context().newPage()
      await printPage.setContent(srcdoc, { waitUntil: 'load' })
      const pdfPath = path.join(EVIDENCE, 'export.pdf')
      await printPage.pdf({ path: pdfPath, format: 'A4' })
      await printPage.screenshot({ path: path.join(EVIDENCE, 'export-pdf-render.png') })
      const visible = (await printPage.locator('body').innerText()).length
      await printPage.close()
      const size = fs.statSync(pdfPath).size
      r.note(`PDF print document: ${srcdoc.length} chars, ${visible} visible text chars, rendered PDF ${size} bytes (${pdfPath})`)
      expect(visible).toBeGreaterThan(500)
      expect(size).toBeGreaterThan(10_000)
    })
  })

  test('10 research run', async ({ page }) => {
    test.setTimeout(JOB_TIMEOUT_MS + 180_000)
    test.skip(projectId() === undefined, 'no project')
    await step(page, '10-research', async (r) => {
      await openTab(page, 'overview')
      const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: /Run Research/ }) })
      await card.getByRole('button').first().click()
      await expect(dialog(page, DIALOG.research)).toBeVisible()
      await runJob(r, 'research', LAMBDAS.research, async () => {
        const posted = page.waitForResponse((res) => isApi(res, 'POST', /\/research$/), { timeout: 60_000 })
        await groundOnPersonasIfNoFeedback(page, DIALOG.research, r)
        await completeWizard(page, DIALOG.research, /^Run Research$/, r, async () => {
          await dialog(page, DIALOG.research).getByPlaceholder('e.g., What are the main pain points...').fill('What are the top three complaints about notifications and billing, and how do they differ by persona?')
          await dialog(page, DIALOG.research).getByPlaceholder('e.g., Delivery Pain Points Analysis').fill(`${E2E_PREFIX}${RUN_ID}-s3 Research`)
        })
        return posted
      })
      const report = (await documentsOf()).find((d) => stringField(d, 'document_type') === 'research')
      r.note(`research doc: ${stringField(report, 'title')} chars=${(stringField(report, 'content') ?? '').length}`)
      expect((stringField(report, 'content') ?? '').length).toBeGreaterThan(500)
    })
  })

  test('11 prototype card smoke', async ({ page }) => {
    test.skip(projectId() === undefined, 'no project')
    await step(page, '11-prototype-smoke', async (r) => {
      await openTab(page, 'overview')
      const build = page.getByRole('button', { name: /Build Prototype/ }).first()
      await build.scrollIntoViewIfNeeded()
      r.note(`Build Prototype disabled=${await build.isDisabled()}`)
      expect(await build.isDisabled(), 'enabled once a PRD exists').toBe(false)
      await build.click()
      await expect(dialog(page, DIALOG.prototype)).toBeVisible()
      r.note(`prototype dialog: ${(await dialog(page, DIALOG.prototype).innerText()).slice(0, 300).replace(/\s+/g, ' ')}`)
      await page.screenshot({ path: path.join(EVIDENCE, 'prototype-dialog.png') })
      await page.keyboard.press('Escape')
      await expect(dialog(page, DIALOG.prototype)).toHaveCount(0, { timeout: 5_000 })
    })
  })

  test('13 collect Lambda REPORT lines per step window (after log ingestion)', async () => {
    // In-step queries run seconds after a job ends and miss late-ingested REPORT lines;
    // this pass re-reads each step's window (startedAt .. startedAt + wallMs) from its record.
    const stepsDir = path.join(OUT_DIR, 'steps')
    const out: Record<string, unknown> = {}
    for (const [prefix, bases] of Object.entries(STEP_LAMBDAS)) {
      const file = path.join(stepsDir, `admin-dark-s3-${prefix}.json`)
      if (!fs.existsSync(file)) continue
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      const start = isRecord(raw) ? Date.parse(stringField(raw, 'startedAt') ?? '') : NaN
      const wall = isRecord(raw) && typeof raw['wallMs'] === 'number' ? raw['wallMs'] : NaN
      if (Number.isNaN(start) || Number.isNaN(wall)) continue
      out[prefix] = { window: { start: new Date(start).toISOString(), end: new Date(start + wall).toISOString() }, ...lambdaEvidence(bases, start - 5_000, start + wall + 5_000) }
    }
    const written = evidence('13-report-lines', out)
    expect(Object.keys(out).length, written).toBeGreaterThan(0)
  })

  test('12 delete the project; avatars swept from S3', async ({ page }) => {
    test.skip(projectId() === undefined, 'no project')
    await step(page, '12-delete-and-sweep', async (r) => {
      const ids = readState().personaIds
      // The keys the project's personas point at now (signed CDN path = S3 key): the
      // proof must SEE them before the delete, or it could never see a leftover (S4).
      const personas = listOf((await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`)).body, 'personas')
      const pointedAt = personas.map((p) => avatarKeyOfUrl(stringField(p, 'avatar_url') ?? '')).filter((k): k is string => k !== null).sort()
      const allIds = [...new Set([...ids, ...personas.map((p) => stringField(p, 'persona_id') ?? '').filter((id) => id !== '')])]
      const beforeObjects = avatarObjects(allIds)
      r.note(`avatar objects before delete: ${beforeObjects.join(', ')} (personas point at: ${pointedAt.join(', ')})`)
      expect(beforeObjects, 'the S3 listing finds every avatar the personas point at').toEqual(expect.arrayContaining(pointedAt))
      await page.goto(site('/projects'), { waitUntil: 'domcontentloaded' })
      await settle(page)
      await persistSession(page)
      if ((await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`)).status === 404) {
        r.note('project already deleted through this UI flow in an earlier attempt (timed out after the DELETE); re-proving only')
      } else {
        await page.getByRole('button', { name: `Delete project ${PROJECT}` }).click()
        await expect(dialog(page, DIALOG.deleteProject)).toBeVisible()
        const deleted = page.waitForResponse((res) => isApi(res, 'DELETE', /\/projects\/[^/]+$/))
        await dialog(page, DIALOG.deleteProject).getByRole('button', { name: 'Delete', exact: true }).click()
        const res = await deleted
        r.note(`DELETE /projects/{id} -> ${res.status()}`)
        expect(res.status()).toBeLessThan(300)
      }
      const check = await apiCall('admin', 'GET', `/projects/${projectId() ?? ''}`)
      r.note(`GET /projects/{id} after delete -> ${check.status}`)
      expect(check.status).toBe(404)
      const afterObjects = avatarObjects(allIds)
      // Every conversation this run started (the stream tap records them as `assistant stream <id>`).
      const conversations = await deleteConversations(runConversations())
      const list = await apiCall('admin', 'GET', '/projects')
      const remaining = listOf(list.body, 'projects').filter((p) => (stringField(p, 'name') ?? '') === PROJECT)
      evidence('12-cleanup-proof', { personaIds: allIds, pointedAt, beforeObjects, afterObjects, conversations, projectsListed: listOf(list.body, 'projects').length, remaining: remaining.length })
      r.note(`after: ${afterObjects.length} avatar objects remain; conversations ${JSON.stringify(conversations)}; project listed: ${remaining.length}`)
      expect(remaining).toEqual([])
      expect(conversations.filter((c) => c.getStatus !== 404), 'conversations left behind').toEqual([])
      expect(afterObjects, 'avatar objects left behind').toEqual([])
    })
  })
})
