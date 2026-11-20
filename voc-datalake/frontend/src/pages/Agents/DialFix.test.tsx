/**
 * The Set up dialog's fix for a failing way of working (7.50.02, S5): offered only while the check fails; "Set mine to
 * AI-driven" asks first, naming both effects, in a group that takes the focus; Cancel saves nothing; Set to AI-driven
 * saves the caller's OWN way of working, then the dialog's readiness and that way of working are read again; a
 * refusal says the server's reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { engineeringReadinessKeys } from '../../api/engineeringReadinessApi'
import { myAiModeKey } from '../../api/queryKeys'
import { DialFix } from './DialFix'
import type { ReadinessCheck } from '../../api/engineeringReadinessApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const MINE = '/users/me/ai-mode'
const dial = (status: ReadinessCheck['status']): ReadinessCheck[] => [{ id: 'dial', status, detail: '', fix: '', docs: '', required: true }]
const CONFIRM = 'This lets the automations you enable push to voc-agent/* branches and open pull requests, and lets AI write your PR/FAQs and PRDs.'

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ [`PUT ${MINE}`]: () => ({ ai_mode: { mode: 'ai_driven', saved: true } }) })
})

function renderFix(checks = dial('fail')) {
  const client = createTestQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  renderWithQueryClient(<DialFix subject={{ automation: 'ag_1', connection: 'conn_1' }} checks={checks} />, client)
  return { invalidate, user: userEvent.setup() }
}

describe('DialFix', () => {
  it('offers nothing while the way of working passes', () => {
    renderFix(dial('pass'))
    expect(screen.queryByTestId('dial-fix')).not.toBeInTheDocument()
  })

  it('asks first, naming both effects, and Cancel saves nothing', async () => {
    const { user } = renderFix()
    await user.click(screen.getByRole('button', { name: 'Set mine to AI-driven' }))
    expect(screen.getByRole('group', { name: CONFIRM })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('saves the caller\'s own way of working, then reads the agent\'s readiness and that way of working again', async () => {
    const { invalidate, user } = renderFix()
    await user.click(screen.getByRole('button', { name: 'Set mine to AI-driven' }))
    await user.click(screen.getByRole('button', { name: 'Set to AI-driven' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved: AI-driven.')
    expect(sentFetchApiBody(MINE, 'PUT')).toStrictEqual({ ai_mode: 'ai_driven' })
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toStrictEqual([
      engineeringReadinessKeys.of({ automation: 'ag_1' }), myAiModeKey(),
    ])
  })

  it('says the server\'s reason when the save is refused', async () => {
    routeFetchApi({ [`PUT ${MINE}`]: () => { throw new ApiError(403, 'Only you may set your way of working') } })
    const { user } = renderFix()
    await user.click(screen.getByRole('button', { name: 'Set mine to AI-driven' }))
    await user.click(screen.getByRole('button', { name: 'Set to AI-driven' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only you may set your way of working')
  })
})
