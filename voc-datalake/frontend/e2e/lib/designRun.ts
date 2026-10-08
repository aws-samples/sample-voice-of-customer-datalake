/**
 * Shared pieces of the design-track specs: which viewport a project runs at,
 * how screen ids are resolved (prod API with the role's token, or the local
 * mock without auth), and the per-step deep evidence.
 */
import { test, type Page, type TestInfo } from '@playwright/test'
import { apiCall, listOf, stringField } from './api'
import type { Role } from './env'
import { pinAllTime, roleOf } from './fixtures'
import type { Screen } from './inventory'
import type { StepRecorder } from './recorder'
import { deepAudit, keyboardAudit } from './deepAudit'

export type Viewport = 'desktop' | 'mobile'

export function viewportOf(testInfo: TestInfo): Viewport {
  return testInfo.project.metadata['viewport'] === 'mobile' ? 'mobile' : 'desktop'
}

export type Ids = Partial<Record<NonNullable<Screen['needs']>, string>>

/** A GET body (`apiCall` sends no token to the dev mock, see `MOCK` in lib/env.ts); null on a non-2xx. */
async function getJson(role: Role, path: string): Promise<unknown> {
  const result = await apiCall(role, 'GET', path)
  return result.status < 300 ? result.body : null
}

export async function resolveIds(role: Role): Promise<Ids> {
  const [projects, agents, feedback] = await Promise.all([
    getJson(role, '/projects'), getJson(role, '/agents'), getJson(role, '/feedback?days=0&limit=1'),
  ])
  return {
    project: stringField(listOf(projects, 'projects')[0], 'project_id', 'id'),
    agent: stringField(listOf(agents, 'items')[0] ?? listOf(agents, 'agents')[0], 'agent_id', 'id'),
    feedback: stringField(listOf(feedback, 'items')[0], 'feedback_id', 'id'),
  }
}

/**
 * Inside a `test.describe`: resolves the screen ids once for the project's
 * role and pins the All-time range before each test. Returns the ids object
 * (filled by the beforeAll).
 */
export function useDesignIds(): Ids {
  const ids: Ids = {}
  test.beforeAll(async ({}, testInfo) => { Object.assign(ids, await resolveIds(roleOf(testInfo))) })
  test.beforeEach(async ({ page }) => { await pinAllTime(page) })
  return ids
}

export function resolvePath(screen: Screen, ids: Ids): string | null {
  if (screen.needs === undefined) return screen.path
  const id = ids[screen.needs]
  return id === undefined ? null : screen.path.replace(`{${screen.needs}}`, encodeURIComponent(id))
}

/** Deep design audit, plus a keyboard walk when asked; attached to the step record. */
export async function attachDeep(page: Page, recorder: StepRecorder, options: { keyboard: boolean; scope?: string }): Promise<void> {
  await recorder.screenshotNow()
  recorder.attach('deep', await deepAudit(page))
  if (options.keyboard) {
    recorder.attach('keyboard', await keyboardAudit(page, { scope: options.scope }))
    await page.keyboard.press('Escape').catch(() => undefined)
  }
}
