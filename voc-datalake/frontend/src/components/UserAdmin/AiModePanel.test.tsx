/**
 * Users → Ways of working with AI: a segmented control per person (AI-driven when nothing is
 * stored), the PR/FAQ / PRD unlocks only inside Human-driven, one PUT per change, and a
 * failed save said in words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import type { CognitoUser } from '../../api/types'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { default: AiModePanel } = await import('./AiModePanel')

type Row = CognitoUser & { ai_mode?: unknown }

const person = (username: string, aiMode?: unknown): Row => ({
  username, email: `${username}@example.com`, name: username, status: 'CONFIRMED', enabled: true, groups: ['users'],
  created_at: null, last_modified: null, ...(aiMode === undefined ? {} : { ai_mode: aiMode }),
})

const HUMAN = { mode: 'human_driven', ai_writing_prfaq: true, ai_writing_prd: false }

const modesOf = (email: string) => screen.getByRole('radiogroup', { name: email })

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ ai_mode: HUMAN })
})

describe('AiModePanel', () => {
  it('shows AI-driven for a person with no stored mode, and no unlocks', () => {
    renderWithQueryClient(<AiModePanel users={[person('vic')]} />)

    expect(within(modesOf('vic@example.com')).getByRole('radio', { name: 'AI-driven' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /with AI/ })).not.toBeInTheDocument()
  })

  it('explains each mode in its tooltip', () => {
    renderWithQueryClient(<AiModePanel users={[person('vic')]} />)

    expect(within(modesOf('vic@example.com')).getByRole('radio', { name: 'Human-driven' }))
      .toHaveAttribute('title', 'AI answers questions, explains the method and reviews; it never writes the document for you.')
  })

  it('PUTs the new mode for that person only', async () => {
    renderWithQueryClient(<AiModePanel users={[person('vic'), person('ada')]} />)

    await userEvent.click(within(modesOf('vic@example.com')).getByRole('radio', { name: 'Human-driven' }))

    await waitFor(() => expect(fetchApi.mock.calls).toStrictEqual([
      ['/users/vic/flags', { method: 'PUT', body: '{"ai_mode":"human_driven"}' }],
    ]))
  })

  it('sends nothing when the current mode is clicked again', async () => {
    renderWithQueryClient(<AiModePanel users={[person('vic')]} />)

    await userEvent.click(within(modesOf('vic@example.com')).getByRole('radio', { name: 'AI-driven' }))

    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('offers the PR/FAQ and PRD unlocks inside Human-driven, reflecting what is stored', () => {
    renderWithQueryClient(<AiModePanel users={[person('vic', HUMAN)]} />)

    expect(screen.getByRole('checkbox', { name: 'PR/FAQ with AI: vic@example.com' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'PRD with AI: vic@example.com' })).not.toBeChecked()
  })

  it('PUTs one unlock when it is ticked', async () => {
    renderWithQueryClient(<AiModePanel users={[person('vic', HUMAN)]} />)

    await userEvent.click(screen.getByRole('checkbox', { name: 'PRD with AI: vic@example.com' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/users/vic/flags', { method: 'PUT', body: '{"ai_writing_prd":true}' }))
  })

  it('says when a change could not be saved', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderWithQueryClient(<AiModePanel users={[person('vic')]} />)

    await userEvent.click(within(modesOf('vic@example.com')).getByRole('radio', { name: 'AI-assisted' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the way of working. Try again.')
  })
})
