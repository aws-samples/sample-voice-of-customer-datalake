/**
 * "Erase one person's feedback": a job row shows how many of its deleted reviews were a workspace's, and an erasure
 * by email says, before and in the confirm dialog, that it also reaches every workspace (the other fields do not).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { supportProfile } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import ErasurePanel from './ErasurePanel'
import { normalizeSourceProfiles } from '../../api/sourceProfilesApi'

const PROFILES = normalizeSourceProfiles({ sources: [supportProfile] })
const REACH = /also deletes this person's reviews in every workspace/
const done = {
  job_id: 'er_00000000abcd', status: 'completed', field: 'email', value_hash: 'f'.repeat(64),
  deleted_items: 3, deleted_objects: 5, deleted_workspace_items: 2, started_by: 'admin', created_at: '2026-01-01',
}

const panel = () => screen.findByRole('region', { name: "Erase one person's feedback" })

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
    const user = userEvent.setup()
    renderWithQueryClient(<ErasurePanel profiles={PROFILES} />)
    const region = await panel()
    const matchOn = within(region).getByLabelText('Match on')
    expect(within(region).queryByText(REACH)).not.toBeInTheDocument()

    await user.selectOptions(matchOn, 'email')
    expect(within(region).getByText(REACH)).toBeInTheDocument()
    expect(matchOn).toHaveAccessibleDescription(REACH)

    await user.type(within(region).getByLabelText('Value'), 'jane@example.com')
    await user.type(within(region).getByLabelText('Legal basis'), 'GDPR art. 17 request #789')
    await user.click(within(region).getByRole('button', { name: 'Erase' }))
    expect(within(await screen.findByRole('dialog')).getByText(REACH)).toBeInTheDocument()
  })
})
