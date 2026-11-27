/**
 * "Erase one person's feedback": a job row shows how many of its deleted reviews were a workspace's, and an erasure
 * by email says, before and in the confirm dialog, that it also reaches every workspace (the other fields do not).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { supportProfile } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import ErasurePanel from './ErasurePanel'
import { normalizeSourceProfiles } from '../../api/sourceProfilesApi'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import { ACME, JUNIPER } from '../../test/workspaceFixtures'

const PROFILES = normalizeSourceProfiles({ sources: [supportProfile] })
const REACH = /also deletes this person's reviews in every workspace/
const THIS_WORKSPACE = /deletes this workspace's reviews only/
const done = {
  job_id: 'er_00000000abcd', status: 'completed', field: 'email', value_hash: 'f'.repeat(64),
  deleted_items: 3, deleted_objects: 5, deleted_workspace_items: 2, started_by: 'admin', created_at: '2026-01-01',
  finished_at: '2026-01-01T00:10:00Z',
  deployment_projects_walked: true, participants_walked: true, participants_complete: true,
}
/** The deployment's erasure by email that did not walk its own projects (7.48.00's rerun rule). */
const rerun = { ...done, job_id: 'er_00000000beef', value_hash: 'a'.repeat(64), participants_walked: true,
  participants_complete: true, deployment_projects_walked: false }
/** A workspace's own erasure by email whose participants are not complete. */
const inAcme = { ...done, job_id: 'er_00000000acme', value_hash: 'b'.repeat(64), workspace_id: ACME.id,
  participants_walked: true, participants_complete: false }
const inJuniper = { ...inAcme, job_id: 'er_00000000jnpr', value_hash: 'c'.repeat(64), workspace_id: JUNIPER.id }

const panel = () => screen.findByRole('region', { name: "Erase one person's feedback" })

/** The panel rendered, with its "Match on" picker. */
async function renderPanel() {
  const user = userEvent.setup()
  renderWithQueryClient(<ErasurePanel profiles={PROFILES} />)
  const region = await panel()
  return { user, region, matchOn: within(region).getByLabelText('Match on') }
}

/** Fill an erasure by email and press Erase: the confirm dialog. */
async function confirmEmailErasure(user: ReturnType<typeof userEvent.setup>, region: HTMLElement): Promise<HTMLElement> {
  await user.selectOptions(within(region).getByLabelText('Match on'), 'email')
  await user.type(within(region).getByLabelText('Value'), 'jane@example.com')
  await user.type(within(region).getByLabelText('Legal basis'), 'GDPR art. 17 request #789')
  await user.click(within(region).getByRole('button', { name: 'Erase' }))
  return screen.findByRole('dialog')
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ 'GET /settings/erasure': () => ({ jobs: [done], sources: [] }) })
})

describe('ErasurePanel', () => {
  it("shows a job's deleted reviews in workspaces in its row", async () => {
    renderWithQueryClient(<ErasurePanel profiles={PROFILES} />)
    const region = await panel()
    await within(region).findByText('Deleted reviews in workspaces: 2')
    const row = within(region).getByRole('listitem')
    expect(within(row).getByText('Deleted reviews in workspaces: 2')).toBeInTheDocument()
    expect(within(row).getByText('3 reviews, 5 raw objects deleted')).toBeInTheDocument()
  })

  it('says an erasure by email reaches every workspace, and an erasure by author does not', async () => {
    const { user, region, matchOn } = await renderPanel()
    expect(within(region).queryByText(REACH)).not.toBeInTheDocument()

    await user.selectOptions(matchOn, 'email')
    expect(within(region).getByText(REACH)).toBeInTheDocument()
    expect(matchOn).toHaveAccessibleDescription(REACH)
    expect(within(await confirmEmailErasure(user, region)).getByText(REACH)).toBeInTheDocument()
  })

  it("lists the deployment's jobs only, and reads one that must run again as such (3g-ui)", async () => {
    routeFetchApi({ 'GET /settings/erasure': () => ({ jobs: [rerun, inAcme], sources: [] }) })
    renderWithQueryClient(<ErasurePanel profiles={PROFILES} />)
    const region = await panel()
    await within(region).findByText(rerun.value_hash.slice(0, 12))
    expect(within(region).getByText('Completed: run again')).toBeInTheDocument()
    expect(within(region).getByText(/^The deployment's own projects were not searched/))
      .toHaveTextContent("Submit this erasure again with the person's address and legal basis")
    expect(within(region).queryByText(inAcme.value_hash.slice(0, 12))).not.toBeInTheDocument()
  })

  it('reads an older rerun as done once a later erasure of the same address completed (3g-ui)', async () => {
    const later = { ...rerun, job_id: 'er_00000000cafe', created_at: '2026-02-01', finished_at: '2026-02-01T00:10:00Z',
      deployment_projects_walked: true }
    routeFetchApi({ 'GET /settings/erasure': () => ({ jobs: [later, rerun], sources: [] }) })
    renderWithQueryClient(<ErasurePanel profiles={PROFILES} />)
    const region = await panel()
    expect(await within(region).findByText('A later erasure of the same address finished the steps this one had to be submitted again for.')).toBeInTheDocument()
    expect(within(region).queryByText('Completed: run again')).not.toBeInTheDocument()
  })

  describe('inside a workspace', () => {
    // The request names the workspace there (X-Workspace-Id), and the server erases its reviews only (7.09.00).
    beforeEach(() => setCurrentWorkspace(ACME))
    afterEach(() => setCurrentWorkspace(null))

    it("lists that workspace's jobs only, and says a rerun is the workspace's own (3g-ui)", async () => {
      routeFetchApi({ 'GET /settings/erasure': () => ({ jobs: [rerun, inAcme, inJuniper], sources: [] }) })
      renderWithQueryClient(<ErasurePanel profiles={PROFILES} />)
      const region = await panel()
      await within(region).findByText(inAcme.value_hash.slice(0, 12))
      expect(within(region).queryByText(rerun.value_hash.slice(0, 12))).not.toBeInTheDocument()
      expect(within(region).queryByText(inJuniper.value_hash.slice(0, 12))).not.toBeInTheDocument()
      expect(within(region).getByText('Completed: run again')).toBeInTheDocument()
      expect(within(region).getByText(/^Not every participant record/)).toHaveTextContent('Submit this erasure again from this workspace')
    })

    it("says the erasure reaches that workspace's reviews only, by any field, an email included", async () => {
      const { user, region, matchOn } = await renderPanel()
      expect(matchOn).toHaveAccessibleDescription(THIS_WORKSPACE)

      await user.selectOptions(matchOn, 'email')
      expect(within(region).queryByText(REACH)).not.toBeInTheDocument()
      expect(matchOn).toHaveAccessibleDescription(THIS_WORKSPACE)
    })

    it('says so in the confirm dialog too, never that every workspace is reached', async () => {
      const { user, region } = await renderPanel()
      const dialog = await confirmEmailErasure(user, region)
      expect(within(dialog).getByText(THIS_WORKSPACE)).toBeInTheDocument()
      expect(within(dialog).queryByText(REACH)).not.toBeInTheDocument()
    })
  })
})
