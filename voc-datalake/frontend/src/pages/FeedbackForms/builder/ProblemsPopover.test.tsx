import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormV2 } from '../model/formsV2'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import ProblemsPopover from './ProblemsPopover'

/** Open the problems list from its chip (`chip`: the chip's name); answers each problem's line, Go to excluded. */
async function openProblems(form: FormV2, chip: string) {
  const user = userEvent.setup()
  const harness = renderWithDraft(<ProblemsPopover />, form)
  await user.click(screen.getByRole('button', { name: chip }))
  const region = screen.getByRole('region', { name: 'Problems in this form' })
  const lines = within(region).getAllByRole('listitem').map((item) => item.querySelector('p')?.textContent)
  return { user, harness, region, lines }
}

const unwritten = sampleForm({ questions: [{ id: 'q_feedback', type: 'open_text', headline: {}, required: true, long: true, input_type: 'text' }] })
const choice = sampleForm({
  questions: [{
    id: 'q_reason', type: 'single_select', headline: { en: 'Why?' }, required: true, options: [{ code: 'price', label: { en: 'Price' } }],
    other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'list',
  }],
})

describe('ProblemsPopover', () => {
  it('shows nothing while the form is clean', () => {
    renderWithDraft(<ProblemsPopover />, sampleForm())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each([
    ['a question', unwritten, '1 problem', 'Q1 · Write the question.', ['questions', ['q_feedback']]],
    ['an ending', sampleForm({ endings: [{ id: 'end_thanks', title: { en: 'Thank you!' }, button: { label: { en: 'Home' }, url: 'http://example.com' } }] }),
      '1 problem', 'Ending “Thank you!” · The address must start with https://', ['questions', ['end', 'end_thanks']]],
    ['the welcome card', sampleForm({ welcome: { enabled: true, title: {} } }), '1 problem', 'Welcome card · The welcome screen needs a title.', ['questions', ['welcome']]],
    ['a hidden field', sampleForm({ hidden_fields: [{ id: 'Plan' }] }), '1 problem',
      'Hidden field Plan · Start with a letter; use lower-case letters, digits and _.', ['hidden-fields']],
    ['a language', sampleForm({ languages: ['en', 'pl'] }), '1 warning',
      'Polski · Polski is missing 2 texts; Polski speakers will see them in English.', ['languages', ['pl']]],
    ['the whole form', choice, '1 warning',
      'Form · No option files feedback under a category and the form has none: set one in Settings › Category routing.', ['settings']],
  ])('lists a problem of %s where it is, and Go to selects it', async (_where, form, chip, line, place) => {
    const { user, harness, lines } = await openProblems(form, chip)
    expect(lines).toStrictEqual([line])
    await user.click(screen.getByRole('button', { name: 'Go to' }))
    expect(harness.go).toHaveBeenCalledWith(...place)
    expect(screen.queryByRole('region', { name: 'Problems in this form' })).not.toBeInTheDocument()
  })

  it('counts the errors that block Save, the warnings listed after them', async () => {
    const { lines } = await openProblems({ ...unwritten, languages: ['en', 'pl'] }, '1 problem')
    expect(lines).toStrictEqual(['Q1 · Write the question.', 'Polski · Polski is missing 1 text; Polski speakers will see it in English.'])
  })

  it('closes on Escape, back on its chip', async () => {
    const { user } = await openProblems(unwritten, '1 problem')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Problems in this form' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1 problem' })).toHaveFocus()
  })

  it('closes when its chip is pressed again', async () => {
    const { user } = await openProblems(unwritten, '1 problem')
    await user.click(screen.getByRole('button', { name: '1 problem' }))
    expect(screen.getByRole('button', { name: '1 problem' })).toHaveAttribute('aria-expanded', 'false')
  })
})
