/**
 * Archiving workflows the way an admin does it: the Workflow library on /agents
 * (WorkflowLibrary.tsx) — "Archive <name>" → "Archive this workflow?" → Archive,
 * which sends `DELETE /workflows/{id}` (an archive: revisions are kept). The
 * built-in template has no Archive button, and the API refuses it with a 409.
 *
 * A row carries only its name, so a workflow whose name is not unique in the
 * library is archived through the API instead: the UI path must never be able to
 * archive somebody else's workflow that happens to share a name.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { apiCall, listOf, stringField } from './api'
import { dialogNamed } from './dialogs'
import { BUILTIN_WORKFLOW_ID } from './env'
import { isApi, settle, site } from './fixtures'
/** agents.json editor.builtin: the badge the built-in row shows instead of Archive. */
const BUILTIN_BADGE = 'Built-in template — save a copy to change it.'

export interface ArchiveProof {
  id: string
  name: string
  via: 'ui' | 'api' | 'not listed'
  status: number
}

const library = (page: Page): Locator => page.getByRole('region', { name: 'Workflow library' })

/** The library's (unarchived) workflows: id → name. */
async function listedWorkflows(): Promise<Map<string, string>> {
  const listed = await apiCall('admin', 'GET', '/workflows')
  const entries = listOf(listed.body, 'items').flatMap((w) => {
    const id = stringField(w, 'workflow_id')
    return id === undefined ? [] : [[id, stringField(w, 'name') ?? ''] as const]
  })
  return new Map(entries)
}

/** Archive each id through the library (or the API when its name is ambiguous); answers what happened to each. */
export async function archiveWorkflowsInLibrary(page: Page, ids: readonly string[]): Promise<ArchiveProof[]> {
  const listed = await listedWorkflows()
  const nameCounts = new Map<string, number>()
  for (const name of listed.values()) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  await page.goto(site('/agents'), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await expect(library(page)).toBeVisible()
  const proof: ArchiveProof[] = []
  for (const id of ids) {
    const name = listed.get(id)
    if (name === undefined) {
      proof.push({ id, name: '', via: 'not listed', status: 0 })
      continue
    }
    if (nameCounts.get(name) !== 1) {
      const res = await apiCall('admin', 'DELETE', `/workflows/${encodeURIComponent(id)}`)
      proof.push({ id, name, via: 'api', status: res.status })
      continue
    }
    proof.push({ id, name, via: 'ui', status: await archiveInUi(page, id, name) })
  }
  return proof
}

/** One row's Archive → confirm → the DELETE status; the row is gone afterwards. */
async function archiveInUi(page: Page, id: string, name: string): Promise<number> {
  const archive = library(page).getByRole('button', { name: `Archive ${name}`, exact: true })
  const archived = page.waitForResponse((res) => isApi(res, 'DELETE', new RegExp(`/workflows/${id}$`)))
  await archive.click()
  const confirm = dialogNamed(page, 'Archive this workflow?')
  await expect(confirm).toContainText(name)
  await confirm.getByRole('button', { name: 'Archive', exact: true }).click()
  const status = (await archived).status()
  await expect(archive).toHaveCount(0)
  return status
}

/** The built-in row offers no Archive, and `DELETE /workflows/wf_default` is refused (409). Returns the status. */
export async function expectBuiltinNotArchivable(page: Page): Promise<number> {
  const builtinName = (await listedWorkflows()).get(BUILTIN_WORKFLOW_ID)
  const row = library(page).getByRole('listitem').filter({ hasText: BUILTIN_BADGE })
  await expect(row.first()).toBeVisible()
  if (builtinName !== undefined) await expect(library(page).getByRole('button', { name: `Archive ${builtinName}`, exact: true })).toHaveCount(0)
  await expect(row.getByRole('button', { name: /^Archive/ })).toHaveCount(0)
  const refused = await apiCall('admin', 'DELETE', `/workflows/${BUILTIN_WORKFLOW_ID}`)
  expect(refused.status, 'the built-in workflow cannot be archived').toBe(409)
  return refused.status
}
