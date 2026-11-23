/**
 * The Results filters (UX §10.1): the range, the language, the ending, "Filter: hidden field" for a hidden field's
 * value (each active one a removable chip), and "Include test responses".
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormV2 } from '../model/formsV2'
import { RESULTS_FORM } from './results-fixtures'
import { CLEAR_FILTERS } from './resultFilters'
import type { ViewFilters } from './resultFilters'
import ResultsFilterBar from './ResultsFilterBar'

const FORM: FormV2 = {
  ...RESULTS_FORM,
  languages: ['en', 'pl'],
  endings: [{ id: 'end_thanks', title: { en: 'Thank you' } }, { id: 'end_sorry', title: {} },
    { id: 'end_event', title: { en: 'See you at {{event|the next one}}' } }],
  hidden_fields: [{ id: 'user_id', label: 'User' }, { id: 'app_version' }],
}

function renderBar(filters: ViewFilters = CLEAR_FILTERS) {
  const onChange = vi.fn<(filters: ViewFilters) => void>()
  const onIncludeTest = vi.fn<(on: boolean) => void>()
  render(<ResultsFilterBar form={FORM} filters={filters} onChange={onChange} includeTest={false} onIncludeTest={onIncludeTest} />)
  return { user: userEvent.setup(), onChange, onIncludeTest }
}

const adder = () => screen.getByRole('group', { name: 'Filter by a hidden field' })

describe('ResultsFilterBar', () => {
  it('changes the range', async () => {
    const { user, onChange } = renderBar()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Time range' }), 'Last 7 days')
    expect(onChange).toHaveBeenCalledWith({ ...CLEAR_FILTERS, range: '7' })
  })

  it('offers the form\'s languages and endings, an untitled ending by its id', async () => {
    const { user, onChange } = renderBar()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'Polski')
    expect(onChange).toHaveBeenLastCalledWith({ ...CLEAR_FILTERS, language: 'pl' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Ending' }), 'end_sorry')
    expect(onChange).toHaveBeenLastCalledWith({ ...CLEAR_FILTERS, ending: 'end_sorry' })
  })

  it('shows an ending\'s recall placeholder as [id], as a headline reads (L2, 7.71.02)', () => {
    renderBar()
    const ending = within(screen.getByRole('combobox', { name: 'Ending' }))
    expect(ending.getAllByRole('option').map((option) => option.textContent)).toStrictEqual(
      ['All endings', 'Thank you', 'end_sorry', 'See you at [event]'])
  })

  it('adds a hidden field filter: the field picked, the value typed', async () => {
    const { user, onChange } = renderBar()
    await user.click(screen.getByRole('button', { name: 'Filter: hidden field' }))
    expect(within(adder()).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['User (user_id)', 'app_version'])
    await user.selectOptions(within(adder()).getByRole('combobox', { name: 'Hidden field' }), 'app_version')
    await user.type(within(adder()).getByRole('textbox', { name: 'Value' }), '2.1')
    await user.click(within(adder()).getByRole('button', { name: 'Add filter' }))
    expect(onChange).toHaveBeenCalledWith({ ...CLEAR_FILTERS, hidden: { app_version: '2.1' } })
  })

  it('adds the first field\'s filter on Enter, trimmed, and closes', async () => {
    const { user, onChange } = renderBar()
    await user.click(screen.getByRole('button', { name: 'Filter: hidden field' }))
    await user.type(within(adder()).getByRole('textbox', { name: 'Value' }), '  qa-17 {Enter}')
    expect(onChange).toHaveBeenCalledWith({ ...CLEAR_FILTERS, hidden: { user_id: 'qa-17' } })
    expect(screen.queryByRole('group', { name: 'Filter by a hidden field' })).not.toBeInTheDocument()
  })

  it('adds nothing without a value, and Cancel closes', async () => {
    const { user, onChange } = renderBar()
    await user.click(screen.getByRole('button', { name: 'Filter: hidden field' }))
    await user.type(within(adder()).getByRole('textbox', { name: 'Value' }), '   {Enter}')
    expect(within(adder()).getByRole('button', { name: 'Add filter' })).toBeDisabled()
    await user.click(within(adder()).getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Filter: hidden field' })).toBeInTheDocument()
  })

  it('shows an active hidden field filter as a chip that removes it, and offers only the other fields', async () => {
    const { user, onChange } = renderBar({ ...CLEAR_FILTERS, hidden: { user_id: 'qa-17' } })
    await user.click(screen.getByRole('button', { name: 'Filter: hidden field' }))
    expect(within(adder()).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['app_version'])
    await user.click(screen.getByRole('button', { name: 'Remove the filter user_id = qa-17' }))
    expect(onChange).toHaveBeenCalledWith(CLEAR_FILTERS)
  })

  it('offers no hidden field filter once every field has one', () => {
    renderBar({ ...CLEAR_FILTERS, hidden: { user_id: 'qa-17', app_version: '2.1' } })
    expect(screen.queryByRole('button', { name: 'Filter: hidden field' })).not.toBeInTheDocument()
  })

  it('turns test responses on', async () => {
    const { user, onIncludeTest } = renderBar()
    await user.click(screen.getByRole('switch', { name: 'Include test responses' }))
    expect(onIncludeTest).toHaveBeenCalledWith(true)
  })
})
