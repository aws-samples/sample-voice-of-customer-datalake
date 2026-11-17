/**
 * People → a person's editor → Way of working with AI: a segmented control ("Not set" with no option selected when
 * nothing is saved, 7.50.02: the engineering automations push nothing for them), arrow keys moving the focus without
 * saving, a visible comparison of the modes, the PR/FAQ / PRD unlocks only inside Human-driven, one PUT per change,
 * and a failed save said in words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { personRow } from './userAdmin-sheet-fixtures'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { default: WaysOfWorking } = await import('./WaysOfWorking')

const HUMAN = { mode: 'human_driven', ai_writing_prfaq: true, ai_writing_prd: false }
const NOTHING_SAVED = { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false, saved: false }
const SAVED_AI_DRIVEN = { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false, saved: true }
const NOT_SET_EFFECT = "Documents use AI-driven · automations won't push until you choose"

const vic = (aiMode?: unknown) => personRow('vic', aiMode === undefined ? {} : { ai_mode: aiMode })
const modes = () => screen.getByRole('radiogroup', { name: 'Way of working with AI' })
const renderFor = (aiMode?: unknown) => renderWithQueryClient(<WaysOfWorking user={vic(aiMode)} />)

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ ai_mode: HUMAN })
})

describe('WaysOfWorking', () => {
  it.each([['nothing saved', NOTHING_SAVED], ['no ai_mode block', undefined]])(
    'shows "Not set" with no option selected for a person with %s, and no unlocks', (_case, aiMode) => {
      renderFor(aiMode)

      expect(within(modes()).getAllByRole('radio').filter((radio) => radio.getAttribute('aria-checked') === 'true')).toStrictEqual([])
      expect(screen.getByText('Not set')).toHaveClass('badge', 'badge-warn')
      expect(modes()).toHaveAccessibleDescription(NOT_SET_EFFECT)
      expect(screen.queryByRole('checkbox', { name: /with AI/ })).not.toBeInTheDocument()
    })

  it('saves AI-driven with one click for a person with nothing saved', async () => {
    renderFor(NOTHING_SAVED)

    await userEvent.click(within(modes()).getByRole('radio', { name: 'AI-driven' }))

    await waitFor(() => expect(fetchApi.mock.calls).toStrictEqual([
      ['/users/vic/flags', { method: 'PUT', body: '{"ai_mode":"ai_driven"}' }],
    ]))
  })

  it('shows an explicitly saved AI-driven as selected, never "Not set"', () => {
    renderFor(SAVED_AI_DRIVEN)

    expect(within(modes()).getByRole('radio', { name: 'AI-driven' })).toBeChecked()
    expect(screen.queryByText('Not set')).not.toBeInTheDocument()
    expect(screen.queryByText(NOT_SET_EFFECT)).not.toBeInTheDocument()
  })

  it('says the mode decides documents and whether the automations a person enables may push', () => {
    renderFor()

    expect(screen.getByText('Sets, per person, how much AI writes their PR/FAQs and PRDs, and whether the engineering '
      + 'automations they enable may push and open pull requests.')).toBeInTheDocument()
  })

  it('compares the modes in view: one row per mode, for documents and for automations', async () => {
    renderFor()

    await userEvent.click(screen.getByText('How the modes differ'))

    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent))
      .toStrictEqual(['Mode', 'Your PR/FAQs and PRDs', 'Automations you enable'])
    expect(within(table).getAllByRole('rowheader').map((cell) => cell.textContent))
      .toStrictEqual(['Human-driven', 'AI-assisted', 'AI-driven'])
    expect(within(within(table).getByRole('row', { name: /^Human-driven/ })).getByText('Push nothing.')).toBeInTheDocument()
  })

  it('moves the focus with the arrow keys, one tab stop, saving nothing', async () => {
    renderFor(SAVED_AI_DRIVEN)
    const group = within(modes())

    expect(group.getAllByRole('radio').map((radio) => radio.tabIndex)).toStrictEqual([-1, -1, 0])
    group.getByRole('radio', { name: 'AI-driven' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(group.getByRole('radio', { name: 'Human-driven' })).toHaveFocus()
    await userEvent.keyboard('{End}{ArrowLeft}')
    expect(group.getByRole('radio', { name: 'AI-assisted' })).toHaveFocus()
  })

  it('saves the focused mode on Space', async () => {
    renderFor(SAVED_AI_DRIVEN)
    within(modes()).getByRole('radio', { name: 'AI-driven' }).focus()

    await userEvent.keyboard('{ArrowLeft} ')

    await waitFor(() => expect(fetchApi.mock.calls).toStrictEqual([
      ['/users/vic/flags', { method: 'PUT', body: '{"ai_mode":"ai_assisted"}' }],
    ]))
  })

  it('puts the tab stop on the first mode while nothing is saved', () => {
    renderFor(NOTHING_SAVED)

    expect(within(modes()).getAllByRole('radio').map((radio) => radio.tabIndex)).toStrictEqual([0, -1, -1])
  })

  it('explains each mode in its tooltip', () => {
    renderFor()

    expect(within(modes()).getByRole('radio', { name: 'Human-driven' }))
      .toHaveAccessibleDescription('AI answers questions, explains the method and reviews; it never writes the document for you.')
  })

  it('sends nothing when the saved mode is clicked again', async () => {
    renderFor(SAVED_AI_DRIVEN)

    await userEvent.click(within(modes()).getByRole('radio', { name: 'AI-driven' }))

    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('offers the PR/FAQ and PRD unlocks inside Human-driven, reflecting what is stored', () => {
    renderFor(HUMAN)

    expect(screen.getByRole('checkbox', { name: 'PR/FAQ with AI' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'PRD with AI' })).not.toBeChecked()
  })

  it('PUTs one unlock when it is ticked', async () => {
    renderFor(HUMAN)

    await userEvent.click(screen.getByRole('checkbox', { name: 'PRD with AI' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/users/vic/flags', { method: 'PUT', body: '{"ai_writing_prd":true}' }))
  })

  it('says when a change could not be saved', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderFor()

    await userEvent.click(within(modes()).getByRole('radio', { name: 'AI-assisted' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the way of working. Try again.')
  })
})
