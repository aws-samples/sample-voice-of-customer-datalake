/**
 * 6.00.00 / 6.04.00: the methodology checked by the server, the feedback catalogue and the erasure's legal basis.
 * Production-safe: the only write is one private `e2e-<run id>-methodology` project (admin API, ledger-recorded,
 * deleted by the shared cleanup); every other request is a read or is refused before any write.
 *
 * - Methodology on the server (docs/project-workspace.md → Methodology): Given an empty project, When
 *   `GET /projects/{id}` is read, Then `methodology.steps` names the upstream steps research, PR/FAQ, PRD and
 *   prototype are missing, and `prototype.blocked` is true. The Overview cards say so (research / documents
 *   hints, the prototype button disabled with its reason). e2e-user cannot see the private project (404).
 * - `POST /projects/{id}/build-prototype` on that project answers 409 before any job (6.04.00 Fixed), and
 *   `GET /projects/{id}/jobs` lists no job afterwards.
 * - Workflow methodology warnings (docs/autonomous-agents.md → Methodology warnings): `POST /workflows/validate`
 *   (stores nothing) answers `warnings` for a PRD step with no evidence, personas or PR/FAQ before it, and the
 *   workflow is still valid; the methodology order has none. Admin: a file imported into the built-in workflow's
 *   editor shows those warnings above the canvas. Nothing is saved (Save is never pressed; no PUT/POST of a
 *   workflow is sent).
 * - `GET /feedback/catalogue` (docs/data-catalogue.md): both roles. Admin: Data Explorer → Processed Feedback →
 *   "Fields" lists every catalogue field.
 * - `POST /settings/erasure` without `legal_basis` → 400 (admin) and 403 (e2e-user); the admin's job list is the
 *   same before and after. The body never carries a legal basis, so it cannot pass validation.
 */
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf } from '../lib/api'
import { BUILTIN_WORKFLOW_ID, RUN_PREFIX } from '../lib/env'
import { isRecord } from '../lib/guards'
import { assertStep, isApi, roleOf, settle, site } from '../lib/fixtures'
import { ensureE2eProject, projectIdOrSkip } from '../lib/projects'

const PROJECT = `${RUN_PREFIX}methodology`

// ── shapes ──────────────────────────────────────────────────────────────────

/** `methodology.steps` of a `GET /projects/{id}` body ({} when absent). */
function methodologySteps(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || !isRecord(body['methodology'])) return {}
  const steps = body['methodology']['steps']
  return isRecord(steps) ? steps : {}
}

function missingOf(steps: Record<string, unknown>, step: string): unknown {
  const entry = steps[step]
  return isRecord(entry) ? entry['missing'] : undefined
}

function warningsOf(body: unknown): Array<Record<string, unknown>> {
  return listOf(body, 'warnings')
}

// ── workflow definitions (validate only, never saved) ───────────────────────

interface StepSpec { readonly id: string; readonly type: string; readonly title: string }

function chain(name: string, steps: readonly StepSpec[]): Record<string, unknown> {
  const all: StepSpec[] = [{ id: 'start', type: 'start', title: 'Start' }, ...steps, { id: 'end', type: 'end', title: 'End' }]
  return {
    schema: 'voc-workflow/1',
    name,
    description: '',
    nodes: all.map((s, i) => ({ id: s.id, type: s.type, position: { x: 0, y: i * 120 }, data: { title: s.title, params: {} } })),
    edges: all.slice(1).map((s, i) => ({ id: `e${i + 1}`, source: all[i]?.id ?? 'start', target: s.id })),
    loops: [],
  }
}

const PRD_TITLE = 'e2e PRD without upstream'
/** start → write_prd → end: no evidence, personas or PR/FAQ before the PRD. */
const gappedWorkflow = (): Record<string, unknown> =>
  chain('e2e methodology gaps (validate only)', [{ id: 'prd', type: 'write_prd', title: PRD_TITLE }])
/** evidence → personas → PR/FAQ → PRD: the methodology order. */
const orderedWorkflow = (): Record<string, unknown> => chain('e2e methodology order (validate only)', [
  { id: 'aggregate', type: 'aggregate_reviews', title: 'Aggregate reviews' },
  { id: 'personas', type: 'generate_personas', title: 'Generate personas' },
  { id: 'prfaq', type: 'write_prfaq', title: 'Write the PR/FAQ' },
  { id: 'prd', type: 'write_prd', title: 'Write the PRD' },
])

// ── tests ───────────────────────────────────────────────────────────────────

test.describe('methodology on the server (6.04.00)', () => {
  test.beforeAll(async () => {
    await ensureE2eProject(PROJECT, 'private')
  })

  test('GET /projects/{id} names the missing upstream steps of an empty project', async ({}, testInfo) => {
    const id = projectIdOrSkip(PROJECT)
    const res = await apiCall(roleOf(testInfo), 'GET', `/projects/${encodeURIComponent(id)}`)
    if (roleOf(testInfo) === 'user') {
      expect(res.status, 'a private project of another user is invisible').toBe(404)
      return
    }
    expect(res.status).toBe(200)
    const steps = methodologySteps(res.body)
    expect(missingOf(steps, 'personas')).toEqual([])
    expect(missingOf(steps, 'research')).toEqual(['personas'])
    expect(missingOf(steps, 'prfaq')).toEqual(['personas'])
    expect(missingOf(steps, 'prd')).toEqual(['personas', 'prfaq'])
    expect(missingOf(steps, 'prototype')).toEqual(['prd', 'prfaq'])
    expect(steps['prototype']).toMatchObject({ blocked: true, count: 0 })
  })

  test('the Overview cards show the server\'s gaps (admin)', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'the project is private to the admin')
    const id = projectIdOrSkip(PROJECT)
    await assertStep(page, 'admin', 'methodology-overview', async (r) => {
      await page.goto(site(`/projects/${id}`), { waitUntil: 'domcontentloaded' })
      // OverviewTab.tsx hints (methodologyHint.ts) and the prototype card's disabled reason.
      await expect(page.getByText('Generate personas first to ground the research in them.')).toBeVisible()
      await expect(page.getByText(
        'Generate personas first: the methodology writes the PR/FAQ and PRD from them. Write the PR/FAQ before the PRD: the methodology reads it.',
      )).toBeVisible()
      await expect(page.getByRole('button', { name: /Build Prototype$/ })).toBeDisabled()
      await expect(page.getByText('Create a PRD or a PR/FAQ first to enable prototype build')).toBeVisible()
      r.note('research + documents hints shown, Build Prototype disabled')
    })
  })

  test('build-prototype on an empty project is a 409 before any job', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    const id = encodeURIComponent(projectIdOrSkip(PROJECT))
    const res = await apiCall(role, 'POST', `/projects/${id}/build-prototype`, {})
    if (role === 'user') {
      expect(res.status, 'a private project of another user is invisible').toBe(404)
      return
    }
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(409)
    expect(JSON.stringify(res.body)).toContain('No PRD or PR/FAQ found')
    const jobs = await apiCall('admin', 'GET', `/projects/${id}/jobs`)
    expect(jobs.status).toBe(200)
    expect(listOf(jobs.body, 'jobs'), 'no job row was written').toEqual([])
  })
})

test.describe('workflow methodology warnings (6.04.00)', () => {
  test('validate warns on a PRD with nothing before it, and stays valid', async ({}, testInfo) => {
    const res = await apiCall(roleOf(testInfo), 'POST', '/workflows/validate', { definition: gappedWorkflow() })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ valid: true })
    const codes = warningsOf(res.body).filter((w) => w['node_id'] === 'prd').map((w) => w['code'])
    expect(codes.sort()).toEqual(['no_upstream_evidence', 'no_upstream_personas', 'no_upstream_prfaq'])
  })

  test('validate has no warning for the methodology order', async ({}, testInfo) => {
    const res = await apiCall(roleOf(testInfo), 'POST', '/workflows/validate', { definition: orderedWorkflow() })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ valid: true })
    expect(warningsOf(res.body)).toEqual([])
  })

  test('the editor shows the warnings above the canvas, nothing saved (admin)', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'Import is an admin control of the editor')
    const writes: string[] = []
    page.on('request', (req) => {
      if (isApi(req, 'PUT', /\/workflows(\/|$)/) || (isApi(req, 'POST', /\/workflows(\/[^/]+)?$/) && !/\/validate$/.test(req.url()))) {
        writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
      }
    })
    await assertStep(page, 'admin', 'methodology-workflow-editor', async (r) => {
      await page.goto(site(`/agents/workflows/${BUILTIN_WORKFLOW_ID}`), { waitUntil: 'domcontentloaded' })
      const canvas = page.getByLabel('Workflow canvas')
      await expect(canvas).toBeVisible()
      const validated = page.waitForResponse((res) => isApi(res, 'POST', /\/workflows\/validate$/) && res.status() === 200)
      await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
        name: 'e2e-methodology-gaps.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(gappedWorkflow())),
      })
      await validated
      const panel = page.getByTestId('workflow-methodology-warnings')
      await expect(panel).toBeVisible()
      await expect(panel).toContainText('Methodology')
      for (const text of [
        'no customer evidence before it (aggregate reviews or deep research).',
        'no personas step before it.',
        'no PR/FAQ step before it: the methodology writes the PR/FAQ first.',
      ]) await expect(panel.getByRole('listitem').filter({ hasText: `${PRD_TITLE}: ${text}` })).toHaveCount(1)
      const [panelBox, canvasBox] = [await panel.boundingBox(), await canvas.boundingBox()]
      expect(panelBox !== null && canvasBox !== null && panelBox.y + panelBox.height <= canvasBox.y, 'warnings sit above the canvas').toBe(true)
      await settle(page, 500)
      expect(writes, 'nothing saved').toEqual([])
      r.note('3 warnings shown above the canvas; no workflow write')
    })
  })
})

test.describe('feedback catalogue (6.04.00)', () => {
  test('GET /feedback/catalogue describes every field', async ({}, testInfo) => {
    const res = await apiCall(roleOf(testInfo), 'GET', '/feedback/catalogue')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ table: 'voc-feedback' })
    const fields = listOf(res.body, 'fields')
    expect(fields.length).toBeGreaterThan(10)
    for (const field of fields) {
      expect(typeof field['name']).toBe('string')
      expect(typeof field['type']).toBe('string')
      expect(typeof field['meaning']).toBe('string')
      expect(Array.isArray(field['set_by'])).toBe(true)
      expect(typeof field['pii']).toBe('string')
      expect(typeof field['under_redact']).toBe('string')
      expect(typeof field['under_summary_only']).toBe('string')
    }
    const byName = new Map(fields.map((f) => [f['name'], f]))
    expect(byName.get('original_text')).toMatchObject({ pii: 'customer_text', under_summary_only: 'replaced' })
    expect(byName.get('usefulness')?.['values']).toEqual(['low', 'medium', 'high'])
    expect(listOf(res.body, 'steps').length).toBeGreaterThan(0)
    expect(listOf(res.body, 'policy_effects').length).toBeGreaterThan(0)
  })

  test('Data Explorer → Processed Feedback → Fields lists the catalogue (admin)', async ({ page }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'Data Explorer is admin-only')
    const api = await apiCall('admin', 'GET', '/feedback/catalogue')
    const names = listOf(api.body, 'fields').map((f) => String(f['name']))
    test.skip(names.length === 0, 'no catalogue from the API')
    await assertStep(page, 'admin', 'methodology-catalogue-fields', async (r) => {
      await page.goto(site('/data-explorer?view=processed'), { waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Fields', exact: true }).click()
      const table = page.getByTestId('feedback-fields-table')
      await expect(table).toBeVisible()
      await expect(table.locator('tbody tr')).toHaveCount(names.length)
      for (const name of ['original_text', 'usefulness', 'pii_policy']) {
        if (names.includes(name)) await expect(table.getByRole('rowheader', { name: new RegExp(`^${name}\\b`) })).toBeVisible()
      }
      await expect(table.getByRole('columnheader')).toHaveCount(7)
      r.note(`${names.length} catalogue fields listed`)
    })
  })
})

test.describe('erasure needs a legal basis (6.00.00)', () => {
  // A valid field and a value that matches nothing, but NO legal basis: refused before any job row.
  const noBasis = { field: 'author', value: `${RUN_PREFIX}no-such-author` }

  test('POST /settings/erasure without legal_basis is refused, no job created', async ({}, testInfo) => {
    const role = roleOf(testInfo)
    const before = await apiCall('admin', 'GET', '/settings/erasure')
    expect(before.status).toBe(200)
    const jobIds = (body: unknown): unknown[] => listOf(body, 'jobs').map((j) => j['job_id'])
    const res = await apiCall(role, 'POST', '/settings/erasure', noBasis)
    if (role === 'admin') {
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(400)
      expect(JSON.stringify(res.body)).toContain('legal_basis is required')
      const blank = await apiCall(role, 'POST', '/settings/erasure', { ...noBasis, legal_basis: '   ' })
      expect(blank.status, 'a blank legal basis').toBe(400)
    } else {
      expect([400, 403], JSON.stringify(res.body).slice(0, 300)).toContain(res.status)
      expect((await apiCall(role, 'GET', '/settings/erasure')).status, 'the job list is admin-only').toBe(403)
    }
    const after = await apiCall('admin', 'GET', '/settings/erasure')
    expect(jobIds(after.body), 'the job list is unchanged').toEqual(jobIds(before.body))
  })
})
