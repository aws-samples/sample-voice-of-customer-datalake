import { afterEach, describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import LanguagesTab from './LanguagesTab'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { templateById, templateForm } from '../formTemplates'
import { catalogueLookup } from './languages/languageEdits'
import type { FormV2 } from '../model/formsV2'

const translated = (overrides: Partial<FormV2> = {}): FormV2 => sampleForm({
  languages: ['en', 'de'],
  questions: [{ id: 'q_feedback', type: 'open_text', headline: { en: 'What would you like to tell us?', de: 'Was möchten Sie uns sagen?' }, required: true, long: true, input_type: 'text' }],
  ...overrides,
})

function oldUi(): FormV2 {
  const flow = templateById('old_ui')
  if (flow === undefined) throw new Error('The old_ui template is missing.')
  return templateForm(flow, 'en', catalogueLookup('en'))
}

const heading = () => screen.getByRole('heading', { level: 2 })

afterEach(() => {
  i18n.removeResourceBundle('pl', 'feedbackForms')
})

describe('LanguagesTab: the translations of a form and how complete they are', () => {
  it('adds a language, which then misses every text, and opens its translation', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LanguagesTab />)
    await user.selectOptions(screen.getByLabelText('Add language'), 'Deutsch')
    await waitFor(() => expect(harness.go).toHaveBeenCalledWith('languages', ['de']))
    expect(harness.probe.current?.form.languages).toStrictEqual(['en', 'de'])
    expect(within(screen.getByTestId('language-de')).getByText('2 missing')).toBeInTheDocument()
  })

  it('writes the language in the side-by-side table, and the count follows', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LanguagesTab />, translated(), { rest: ['de'] })
    expect(heading()).toHaveTextContent('Deutsch (de) · 1 of 2')
    await user.type(screen.getByRole('textbox', { name: 'Deutsch: Title of the ending “Thank you!”' }), 'Danke!')
    expect(heading()).toHaveTextContent('Deutsch (de) · 2 of 2')
    expect(harness.probe.current?.form.endings[0]?.title).toStrictEqual({ en: 'Thank you!', de: 'Danke!' })
  })

  it('marks a missing text, and Only missing shows only those', async () => {
    const user = userEvent.setup()
    renderWithDraft(<LanguagesTab />, translated(), { rest: ['de'] })
    expect(screen.getAllByText('Missing')).toHaveLength(1)
    await user.click(screen.getByRole('switch', { name: 'Only missing' }))
    expect(screen.queryByRole('textbox', { name: 'Deutsch: Question of question 1' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Deutsch: Title of the ending “Thank you!”' })).toBeInTheDocument()
  })

  it('asks before removing a language, then deletes its texts', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LanguagesTab />, translated())
    await user.click(screen.getByRole('button', { name: 'More actions for Deutsch' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove language…' }))
    const dialog = screen.getByRole('dialog', { name: 'Remove Deutsch?' })
    expect(within(dialog).getByText('Its 1 translation is deleted, and Deutsch speakers will see English.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(harness.probe.current?.form.languages).toStrictEqual(['en'])
    expect(harness.probe.current?.form.questions[0]?.headline).toStrictEqual({ en: 'What would you like to tell us?' })
  })

  it('makes only a complete translation the primary', async () => {
    const user = userEvent.setup()
    const complete = translated({ languages: ['en', 'de', 'fr'], endings: [{ id: 'end_thanks', title: { en: 'Thank you!', de: 'Danke!' } }] })
    const harness = renderWithDraft(<LanguagesTab />, complete)
    await user.click(screen.getByRole('button', { name: 'Change…' }))
    expect(screen.getByRole('button', { name: 'Make Français the primary language' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Complete its translation first')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Make Deutsch the primary language' }))
    expect(harness.probe.current?.form.languages).toStrictEqual(['de', 'en', 'fr'])
  })

  it('asks a migrated form without a language which one it is written in, and moves its texts there (D15)', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<LanguagesTab />, sampleForm(), { meta: { language_unconfirmed: true, migrated_from_v1: true } })
    await user.selectOptions(screen.getByLabelText('Written in'), 'Polski')
    expect(harness.probe.current?.form.language).toBe('pl')
    expect(harness.probe.current?.form.languages).toStrictEqual(['pl'])
    expect(harness.probe.current?.form.questions[0]?.headline).toStrictEqual({ pl: 'What would you like to tell us?' })
  })

  it('says a form in one language only can be offered in another', () => {
    renderWithDraft(<LanguagesTab />)
    expect(screen.getByText('This form is in English only. Add a language to offer it in another.')).toBeInTheDocument()
  })

  it('fills a new language from the template’s catalogue where the text is still the template’s', async () => {
    i18n.addResourceBundle('pl', 'feedbackForms', {
      templates: { old_ui: { q: { q_why: { headline: 'Co sprawiło, że wracasz do starego interfejsu?' } }, endings: { end_thanks: { title: 'Dziękujemy' } } } },
    }, true, true)
    const user = userEvent.setup()
    const harness = renderWithDraft(<LanguagesTab />, oldUi(), { isNew: true, handoff: { templateId: 'old_ui' } })
    await user.selectOptions(screen.getByLabelText('Add language'), 'Polski')
    expect(await screen.findByText('2 texts filled from the template. Check them before publishing.')).toBeInTheDocument()
    expect(harness.probe.current?.form.questions[0]?.headline).toStrictEqual({ en: 'What made you switch back to the old interface?', pl: 'Co sprawiło, że wracasz do starego interfejsu?' })
    expect([...harness.probe.current?.fromTemplate ?? []]).toStrictEqual(['pl:q_why.headline', 'pl:end_thanks.endingTitle'])
  })
})
