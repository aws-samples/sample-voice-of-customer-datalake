/**
 * Project fixtures made through the API (not the UI) for specs whose subject is
 * something else on the page. The project is recorded in the ledger the moment
 * its id is known, so cleanup deletes it whatever fails later.
 *
 * Created as the ADMIN (the user role cannot see an admin's private project, and
 * the suite never leaves user-owned projects behind); `visibility: 'public'` makes
 * it visible — and editable — to every signed-in user.
 */
import type { Locator, Page } from '@playwright/test'
import { apiCall, listOf, stringField } from './api'
import { recordCreated, runLedger } from './ledger'
import { isRecord } from './guards'
import { cognitoSubFor } from './session'
import { test } from './test'
import type { Role } from './env'

export type Visibility = 'public' | 'private'

/** The `project` object of a create/get response body, if there is one. */
function projectOf(body: unknown): Record<string, unknown> | undefined {
  return isRecord(body) && isRecord(body['project']) ? body['project'] : undefined
}

/** The ledger's id for this run's project called `name`, if it was created. */
export function ledgerProjectId(name: string): string | undefined {
  return runLedger().find((e) => e.kind === 'project' && e.name === name)?.id
}

/** This run's id for project `name`, or skips the calling test (its create failed). */
export function projectIdOrSkip(name: string): string {
  const id = ledgerProjectId(name)
  test.skip(id === undefined, `no project ${name}`)
  return id ?? ''
}

/**
 * This run's project called `name`: reused when the ledger already has it (a
 * worker restart after a failure), created otherwise. Throws on a failed create.
 */
export async function ensureE2eProject(name: string, visibility: Visibility, description = 'Created by the e2e suite; deleted at the end of the run.'): Promise<string> {
  const existing = ledgerProjectId(name)
  if (existing !== undefined) return existing
  // No spacing between creates: ids carry a random tail, so two in one second
  // no longer collide (shared/ids.py; the old 1.1 s gap is gone).
  const created = await apiCall('admin', 'POST', '/projects', { name, description, visibility })
  const id = stringField(projectOf(created.body), 'project_id', 'id')
  if (created.status >= 300 || id === undefined) throw new Error(`POST /projects -> ${created.status}, no project id`)
  recordCreated('project', id, name)
  return id
}

/** `GET /projects/{id}` as `role`: the status and the META fields a spec compares. */
export async function readProject(role: Role, id: string): Promise<{ status: number; name?: string; description?: string; visibility?: string }> {
  const result = await apiCall(role, 'GET', `/projects/${encodeURIComponent(id)}`)
  const project = projectOf(result.body)
  const text = (key: string): string | undefined => {
    const value = project?.[key]
    return typeof value === 'string' ? value : undefined
  }
  return { status: result.status, name: text('name'), description: text('description'), visibility: text('visibility') }
}

/**
 * Admin invites `member` to project `id` as `memberRole`; a no-op when they are
 * already a member (a re-run after a worker restart). Throws unless the API agreed.
 */
export async function inviteMember(id: string, member: Role, memberRole: 'editor' | 'viewer'): Promise<void> {
  const sub = cognitoSubFor(member)
  const path = `/projects/${encodeURIComponent(id)}/members`
  const current = await apiCall('admin', 'GET', path)
  if (listOf(current.body, 'members').some((m) => m['sub'] === sub)) return
  const invited = await apiCall('admin', 'POST', path, { sub, role: memberRole })
  if (invited.status >= 300) throw new Error(`POST /projects/{id}/members -> ${invited.status}`)
}

/** The /projects list card whose heading is exactly `name`. */
export const projectCard = (page: Page, name: string): Locator =>
  page.locator('.card').filter({ has: page.getByRole('heading', { name, exact: true }) })
