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
import { ACME } from '../../test/workspaceFixtures'

const PROFILES = normalizeSourceProfiles({ sources: [supportProfile] })
const REACH = /also deletes this person's reviews in every workspace/
const THIS_WORKSPACE = /deletes this workspace's reviews only/
const done = {
  job_id: 'er_00000000abcd', status: 'completed', field: 'email', value_hash: 'f'.repeat(64),
  deleted_items: 3, deleted_objects: 5, deleted_workspace_items: 2, started_by: 'admin', created_at: '2026-01-01',
}

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

  describe('inside a workspace', () => {
    // The request names the workspace there (X-Workspace-Id), and the server erases its reviews only (7.09.00).
    beforeEach(() => setCurrentWorkspace(ACME))
    afterEach(() => setCurrentWorkspace(null))

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
