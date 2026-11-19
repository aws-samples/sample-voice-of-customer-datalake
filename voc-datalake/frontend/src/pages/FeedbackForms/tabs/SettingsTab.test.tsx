/**
 * Settings (UX §14.1): category routing by NAME (a form saved with config ids still resolves), the per-option
 * overview, Appearance (second, with its own preview; the theme editor's own spec is theme/ThemeEditor.test.tsx), the
 * anchor list's card in view, and Delete form, asked first and then out of the builder.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const deleteFeedbackForm = vi.fn<(formId: string) => Promise<unknown>>()

vi.mock('../../../api/client', () => ({ api: { deleteFeedbackForm: (formId: string) => deleteFeedbackForm(formId) } }))
vi.mock('../../../hooks/useCategories', () => ({
  useCategoriesConfig: () => ({
    data: {
      categories: [
        { id: 'cat_1', name: 'ease_of_use', description: 'Ease of use', subcategories: [{ id: 'sub_1', name: 'onboarding_flow' }] },
        { id: 'cat_2', name: 'api_automation', subcategories: [] },
      ],
    },
  }),
}))
vi.mock('../../../components/DimensionFields/DimensionDefaultsSection', () => ({ default: () => <div data-testid="dimension-defaults" /> }))
vi.mock('../ValidationLinkPicker', () => ({ default: () => <div data-testid="validation-link" /> }))
vi.mock('../preview/PreviewFrame', () => import('../test/previewFrameStub'))

import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { FormV2 } from '../model/formsV2'
import { DEFAULT_THEME } from '../model/formsV2'
import { stubElementScrollIntoView } from '../../../test/stubScrollTo'
import SettingsTab from './SettingsTab'

const CHOICE: FormV2['questions'][number] = {
  id: 'q_reason', type: 'single_select', headline: { en: "What's the main reason?" }, required: true,
  options: [
    { code: 'price', label: { en: 'Price' }, category: { category: 'ease_of_use' } },
    { code: 'bugs', label: { en: 'Bugs' } },
  ],
  other: { enabled: false }, none: { enabled: false }, shuffle: 'none', display: 'auto',
}

describe('SettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteFeedbackForm.mockResolvedValue({ success: true })
  })

  it('labels each category and stores the name responses are filed under', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<SettingsTab />)
    expect(screen.getByRole('option', { name: 'Ease of use' })).toHaveValue('ease_of_use')
    await user.selectOptions(screen.getByLabelText("The form's category"), 'Ease of use')
    await user.selectOptions(screen.getByLabelText('Subcategory (optional)'), 'Onboarding flow')
    expect([harness.probe.current?.form.category, harness.probe.current?.form.subcategory]).toStrictEqual(['ease_of_use', 'onboarding_flow'])
  })

  it('still resolves a form saved with config ids, and previews the name it will store', () => {
    renderWithDraft(<SettingsTab />, sampleForm({ category: 'cat_1', subcategory: 'sub_1' }))
    expect(screen.getByLabelText("The form's category")).toHaveValue('ease_of_use')
    expect(screen.getByLabelText('Subcategory (optional)')).toHaveValue('onboarding_flow')
    expect(screen.getByText(/category: "ease_of_use"/)).toBeInTheDocument()
  })

  it('lists each choice question with how many options it maps, and opens its routing', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<SettingsTab />, sampleForm({ questions: [CHOICE] }))
    const overview = screen.getByRole('list', { name: 'Per-option routing' })
    expect(within(overview).getByRole('listitem')).toHaveTextContent("1 · What's the main reason?1 of 2 options mapped")
    await user.click(within(overview).getByRole('button', { name: 'Edit the routing of question 1' }))
    expect(harness.go).toHaveBeenCalledWith('questions', ['q_reason'])
  })

  it('shows Appearance second, the style editor with its own preview', () => {
    renderWithDraft(<SettingsTab />)
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(titles.slice(0, 2)).toStrictEqual(['General', 'Appearance'])
    const appearance = screen.getByRole('region', { name: 'Appearance' })
    expect(within(appearance).getByRole('group', { name: 'Preset' })).toBeInTheDocument()
    expect(within(appearance).getByTestId('preview-frame')).toHaveAccessibleName('Form preview, phone size, English')
  })

  it('notes text that is hard to read, and not text that is not', () => {
    const low = renderWithDraft(<SettingsTab />, sampleForm({ theme: { ...DEFAULT_THEME, text_color: '#808080' } }))
    expect(screen.getByRole('note')).toHaveTextContent("Text on the background is 3.9:1, below 4.5:1: many people can't read it.")
    low.unmount()
    renderWithDraft(<SettingsTab />)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('writes a theme colour into the draft', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<SettingsTab />)
    const field = screen.getByRole('textbox', { name: 'Primary' })
    await user.clear(field)
    await user.type(field, '#123456')
    expect(harness.probe.current?.form.theme.primary_color).toBe('#123456')
  })

  it('says which card is in view in its anchor list', async () => {
    const user = userEvent.setup()
    renderWithDraft(<SettingsTab />)
    const anchors = within(screen.getByRole('navigation', { name: 'Settings sections' }))
    expect(anchors.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'true')
    await user.click(anchors.getByRole('link', { name: 'Appearance' }))
    const current = ['General', 'Appearance'].map((name) => anchors.getByRole('link', { name }).getAttribute('aria-current'))
    expect(current).toStrictEqual([null, 'true'])
  })

  it("opens on Appearance from a theme problem's Go to", () => {
    const restore = stubElementScrollIntoView()
    try {
      renderWithDraft(<SettingsTab />, sampleForm(), { rest: ['appearance'] })
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
      const anchors = within(screen.getByRole('navigation', { name: 'Settings sections' }))
      expect(anchors.getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'true')
    } finally {
      restore()
    }
  })

  it('deletes the form only after naming it and its responses, then leaves for the list', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<SettingsTab />, sampleForm(), { meta: { response_count: 214 } })
    await user.click(screen.getByRole('button', { name: 'Delete form…' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Delete “Sample form”? It has 214 responses.')
    await user.click(within(dialog).getByRole('button', { name: 'Delete form' }))
    await waitFor(() => expect(harness.leave).toHaveBeenCalledWith('/feedback-forms'))
    expect(deleteFeedbackForm).toHaveBeenCalledWith('f_test')
  })

  it('has nothing to delete on a new form', () => {
    renderWithDraft(<SettingsTab />, sampleForm(), { isNew: true })
    expect(screen.queryByRole('button', { name: 'Delete form…' })).not.toBeInTheDocument()
  })
})
