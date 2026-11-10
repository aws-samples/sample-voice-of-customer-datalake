/**
 * Persona avatars — "did you check that all personas generated images?" (owner, 5.35).
 * Every check goes through `personaAvatarProblems` (lib/personaAvatars.ts): each persona
 * of `GET /projects/{id}` has a non-empty `avatar_url`, and its Personas-tab card shows an
 * `<img>` whose response is 200 and whose `naturalWidth > 0`; the initials fallback fails.
 *
 * (a) Generate personas from the project page (Personas tab → Generate Personas → the
 *     wizard → Generate Personas → "Generate personas now?" → Generate Personas), follow the job (lib/jobs.ts), then no problems.
 *     - Production: spends Bedrock (text + images, like s3), so it runs only with
 *       `E2E_PERSONA_GENERATE=1` (lib/optIn.ts); admin only, on this run's PUBLIC e2e
 *       project, deleted by the run's cleanup with its personas and avatars.
 *     - Mock: always. The dev mock's generate job writes NO `avatar_url` (it does not
 *       model avatar generation), so the spec first proves the helper reports every
 *       persona there (the fallback counts as a failure), then regenerates each avatar
 *       through `POST …/personas/{pid}/regenerate-avatar` (the mock's inline image) and
 *       asserts no problems.
 * (b) The personas an autonomous-agent run made: this run's projects the ledger holds
 *     under `runProjectLabel` (recorded by lib/agentRuns.ts `recordRunProjects`, e.g. by
 *     s2). None (always on the mock; s2's e2e workflow creates no project) → skipped with
 *     the reason. Since 5.35 agent-made personas get portraits by default (AGENT_NOTE).
 *
 * Local dev mock:
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:5484 E2E_API=http://127.0.0.1:3484 \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/persona-avatars.spec.ts
 * Production (a) opt-in: E2E_PERSONA_GENERATE=1 npx playwright test … tests/persona-avatars.spec.ts
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { dialogNamed } from '../lib/dialogs'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { assertStep, escapeRegExp, isApi, jsonOf, roleOf, settle, site } from '../lib/fixtures'
import { isRecord } from '../lib/guards'
import { followJob } from '../lib/jobs'
import { runLedger } from '../lib/ledger'
import { optIn } from '../lib/optIn'
import { personaAvatarProblems } from '../lib/personaAvatars'
import { ensureE2eProject } from '../lib/projects'
import type { StepRecorder } from '../lib/recorder'

const PROJECT = `${RUN_PREFIX}persona-avatars-project`
const GENERATE_OPT_IN = 'E2E_PERSONA_GENERATE'
const PERSONA_COUNT = '2'
/** Persona generation with images (production: minutes; the mock: two polls). */
const JOB_TIMEOUT_MS = MOCK ? 30_000 : 15 * 60_000
const AGENT_NOTE = 'agent-made personas get portraits by default since 5.35'
/** `runProjectLabel(runId)` of lib/agentRuns.ts, any run id. */
const AGENT_PROJECT_LABEL = new RegExp(`^${escapeRegExp(RUN_PREFIX)}agent-run-.+-project$`)

/** Clicks Next through the persona wizard until its submit shows, then submits; returns the job id. */
async function generateFromWizard(page: Page, r: StepRecorder): Promise<string> {
  const wizard = dialogNamed(page, 'Generate Personas')
  await expect(wizard).toBeVisible()
  const submit = wizard.getByRole('button', { name: 'Generate Personas', exact: true })
  for (let i = 0; i < 6 && !(await submit.isVisible()); i += 1) {
    await wizard.getByRole('button', { name: 'Next', exact: true }).click()
  }
  await wizard.locator('input[type="range"]').fill(PERSONA_COUNT)
  const posted = page.waitForResponse((res) => isApi(res, 'POST', /\/personas\/generate$/), { timeout: 60_000 })
  await submit.click()
  // 5.x asks first: "Generate personas now?" (it spends AI credits).
  await dialogNamed(page, 'Generate personas now?').getByRole('button', { name: 'Generate Personas', exact: true }).click()
  const response = await posted
  const jobId = stringField(await jsonOf(response), 'job_id')
  r.note(`POST /projects/{id}/personas/generate -> ${response.status()} job ${jobId ?? '?'}`)
  expect(response.status()).toBe(200)
  if (jobId === undefined) throw new Error('personas/generate answered no job_id')
  return jobId
}

/** The personas `GET /projects/{id}` lists (admin). */
async function projectPersonas(projectId: string): Promise<Array<Record<string, unknown>>> {
  const project = await apiCall('admin', 'GET', `/projects/${encodeURIComponent(projectId)}`)
  expect(project.status, 'GET /projects/{id}').toBe(200)
  return listOf(project.body, 'personas')
}

/** Mock only: gives every persona an avatar through the regenerate-avatar assist job. */
async function regenerateAvatars(projectId: string, r: StepRecorder): Promise<void> {
  for (const persona of await projectPersonas(projectId)) {
    const pid = stringField(persona, 'persona_id') ?? ''
    const res = await apiCall('admin', 'POST', `/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(pid)}/regenerate-avatar`, {})
    const jobId = stringField(isRecord(res.body) ? res.body : undefined, 'job_id')
    expect(res.status, `regenerate-avatar ${pid}`).toBe(202)
    const trace = await followJob('admin', projectId, jobId ?? '', JOB_TIMEOUT_MS)
    r.note(`regenerate-avatar ${pid} -> ${res.status}, job ${trace.finalStatus}`)
    expect(trace.finalStatus).toBe('completed')
  }
}

test.describe('persona avatars: every persona has an image', () => {
  test('generated personas all show a loaded avatar', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'generating personas is an admin write')
    test.skip(!MOCK && !optIn(GENERATE_OPT_IN), `persona generation spends Bedrock in production: set ${GENERATE_OPT_IN}=1`)
    test.setTimeout(JOB_TIMEOUT_MS + 180_000)
    const projectId = await ensureE2eProject(PROJECT, 'public')

    await assertStep(page, 'admin', 'persona-avatars-generate', async (r) => {
      await page.goto(site(`/projects/${encodeURIComponent(projectId)}?tab=personas`), { waitUntil: 'domcontentloaded' })
      await settle(page, 500)
      await page.getByRole('button', { name: 'Generate Personas', exact: true }).first().click()
      const jobId = await generateFromWizard(page, r)
      const trace = await followJob('admin', projectId, jobId, JOB_TIMEOUT_MS)
      r.note(`persona job ${trace.finalStatus} in ${String(trace.totalMs)} ms${trace.error === null ? '' : `: ${trace.error}`}`)
      expect(trace.finalStatus).toBe('completed')
    })

    if (MOCK) {
      await assertStep(page, 'admin', 'persona-avatars-mock-fallback-detected', async (r) => {
        const problems = await personaAvatarProblems(page, 'admin', projectId)
        r.note(`mock personas without avatars: ${problems.join(' | ')}`)
        for (const persona of await projectPersonas(projectId)) {
          const name = stringField(persona, 'name') ?? ''
          expect(problems.some((p) => p.startsWith(name) && p.includes('initials fallback')), `${name}: fallback reported`).toBe(true)
        }
      })
      await assertStep(page, 'admin', 'persona-avatars-mock-regenerate', (r) => regenerateAvatars(projectId, r))
    }

    await assertStep(page, 'admin', 'persona-avatars-all-loaded', async (r) => {
      const count = (await projectPersonas(projectId)).length
      const problems = await personaAvatarProblems(page, 'admin', projectId)
      r.note(`${count} personas; avatar problems: ${problems.join(' | ') || 'none'}`)
      expect(count, 'personas generated').toBeGreaterThan(0)
      expect(problems).toEqual([])
    })
  })

  test('personas an agent run created all show a loaded avatar', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'agent-created projects are private to the admin')
    testInfo.annotations.push({ type: 'note', description: AGENT_NOTE })
    const projects = runLedger().filter((e) => e.kind === 'project' && AGENT_PROJECT_LABEL.test(e.name))
    test.skip(projects.length === 0, 'this run has no agent-created project in the ledger (lib/agentRuns.ts recordRunProjects found none)')
    for (const project of projects) {
      await assertStep(page, 'admin', `persona-avatars-agent-${project.id}`, async (r) => {
        const problems = await personaAvatarProblems(page, 'admin', project.id)
        r.note(`${project.name} (${project.id}): ${problems.join(' | ') || 'no problems'}`)
        expect(problems, `${project.name}: ${AGENT_NOTE}`).toEqual([])
      })
    }
  })
})
