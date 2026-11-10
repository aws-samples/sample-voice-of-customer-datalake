/**
 * @fileoverview Tests for DocWizard (Wizards.tsx) — the PRD/PR/FAQ doc-type
 * multi-select and the AI authoring assists (prd-fix #17-5/6, shipped in
 * PR #132 without dedicated coverage — added as the P8 test-coverage rider).
 */
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  baseWizardProps, createWizardWrapper, resetWizardMocks,
} from './wizard-fixtures'
import {
  wizardApiClientMock, wizardConfigStoreMock,
} from '../../components/DataSourceWizard/dataSourceWizard-fixtures'
import { DocWizard } from './DocWizard'
import type { DocToolConfig } from './types'

const mockSuggestDocumentBrief = vi.fn<(...args: unknown[]) => unknown>()
const mockAutofillPrfaqQuestions = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestDocumentBrief: (...args: unknown[]) => mockSuggestDocumentBrief(...args),
    autofillPrfaqQuestions: (...args: unknown[]) => mockAutofillPrfaqQuestions(...args),
  },
}))

vi.mock('../../api/client', () => wizardApiClientMock())
vi.mock('../../store/configStore', () => wizardConfigStoreMock())

const createWrapper = createWizardWrapper

const baseDocConfig: DocToolConfig = {
  docTypes: ['prfaq'],
  title: '',
  featureIdea: '',
  customerQuestions: ['', '', '', '', ''],
}

function makeProps(docConfig: Partial<DocToolConfig> = {}) {
  return {
    ...baseWizardProps(),
    docConfig: { ...baseDocConfig, ...docConfig },
    onDocConfigChange: vi.fn(),
  }
}

/** The wizard with its docConfig held in state, as ProjectDetail holds it. */
function StatefulDocWizard({ initial }: Readonly<{ initial: Partial<DocToolConfig> }>) {
  const [docConfig, setDocConfig] = useState<DocToolConfig>({ ...baseDocConfig, ...initial })
  return <DocWizard {...baseWizardProps()} docConfig={docConfig} onDocConfigChange={setDocConfig} />
}

/** Click Next until the final (doc-type) step is visible. */
async function goToFinalStep(user: ReturnType<typeof userEvent.setup>) {
  while (!screen.queryByText(/document type/i)) {
    await user.click(screen.getByRole('button', { name: /next/i }))
  }
}

/** Renders the wizard at its first step with the given doc-type selection. */
function renderWithDocTypes(docTypes: DocToolConfig['docTypes']) {
  render(<DocWizard {...makeProps({ docTypes })} />, { wrapper: createWrapper() })
}

/** Renders the wizard with fresh default props and a user; returns both. */
function renderWizard() {
  const user = userEvent.setup()
  const props = makeProps()
  render(<DocWizard {...props} />, { wrapper: createWrapper() })
  return { user, props }
}

/** Renders the wizard with `props`, walks to the final step and returns the user. */
async function renderAtFinalStep(props: ReturnType<typeof makeProps> = makeProps()) {
  const user = userEvent.setup()
  render(<DocWizard {...props} />, { wrapper: createWrapper() })
  await goToFinalStep(user)
  return user
}

describe('DocWizard', () => {
  beforeEach(resetWizardMocks)

  // #283 stage 2: this wizard was one of the two keyboard traps found by browser
  // testing — no role="dialog", a fused overlay, and Escape did nothing. It now
  // renders through ModalShell, so it inherits dialog semantics and dismissal.
  describe('dialog semantics (ModalShell adoption)', () => {
    it('is exposed as a modal dialog named by its title', () => {
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })

      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      // Asserted as an exact string, not a bare toHaveAccessibleName(): the latter
      // passes on any non-empty name, so it would not have caught the name drifting
      // away from the visible heading.
      expect(dialog).toHaveAccessibleName('Generate PR/FAQ')
    })

    it('keeps the dialog name in step with the doc-type selection', () => {
      // Pins the name to the same value the heading shows, which is what makes the
      // exact assertion above meaningful rather than a hardcoded coincidence.
      renderWithDocTypes(['prfaq', 'prd'])

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Generate PRD + PR/FAQ')
    })

    it('closes on Escape', async () => {
      const { user, props } = renderWizard()

      await user.keyboard('{Escape}')

      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('closes on overlay click but not on panel click', async () => {
      const { user, props } = renderWizard()

      await user.click(screen.getByRole('dialog'))
      expect(props.onClose).not.toHaveBeenCalled()

      await user.click(screen.getByTestId('modal-overlay'))
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('doc-type multi-select', () => {
    it('shows PR/FAQ title when only prfaq is selected', () => {
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })
      expect(screen.getByText('Generate PR/FAQ')).toBeInTheDocument()
    })

    it('shows combined title when both types are selected', () => {
      renderWithDocTypes(['prfaq', 'prd'])
      expect(screen.getByText('Generate PRD + PR/FAQ')).toBeInTheDocument()
    })

    it('adds prd to the selection when its card is clicked (multi-select, not replace)', async () => {
      const props = makeProps()
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: /PRD Product Requirements Document/i }))

      expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ docTypes: ['prfaq', 'prd'] }),
      )
    })

    it('removes a selected type when its card is clicked again', async () => {
      const props = makeProps({ docTypes: ['prfaq', 'prd'] })
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: /PR\/FAQ Amazon-style/i }))

      expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ docTypes: ['prd'] }),
      )
    })
  })

  describe('AI draft brief assist', () => {
    const BRIEF = /— title and description$/

    it('drafts into empty fields and sends them empty, with the feedback selection', async () => {
      mockSuggestDocumentBrief.mockResolvedValue({ title: 'Crash-free login', feature_idea: 'Fix the login crash.' })
      const props = makeProps()
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: 'Draft with AI — title and description' }))

      await waitFor(() => expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Crash-free login', featureIdea: 'Fix the login crash.' }),
      ))
      expect(mockSuggestDocumentBrief).toHaveBeenCalledWith('proj-1', expect.objectContaining({
        doc_type: 'prfaq', title: '', feature_idea: '',
        filters: { days: 30, sources: [], categories: [], sentiments: [] },
      }))
    })

    it('sends what was typed so the draft improves it', async () => {
      mockSuggestDocumentBrief.mockResolvedValue({ title: 'Offline maps', feature_idea: 'Expanded.' })
      const user = await renderAtFinalStep(makeProps({ title: 'Offline maps', featureIdea: 'Save maps' }))
      await user.click(screen.getByRole('button', { name: BRIEF }))
      await user.click(screen.getByRole('button', { name: 'Improve with AI' }))

      await waitFor(() => expect(mockSuggestDocumentBrief).toHaveBeenCalledWith(
        'proj-1', expect.objectContaining({ title: 'Offline maps', feature_idea: 'Save maps' }),
      ))
    })

    it('is labelled "Improve with AI" once a field holds text', async () => {
      await renderAtFinalStep(makeProps({ featureIdea: 'Typed idea' }))

      expect(screen.getByRole('button', { name: BRIEF })).toHaveTextContent('Improve with AI')
    })

    it('shows a hint when the model returns an empty draft', async () => {
      mockSuggestDocumentBrief.mockResolvedValue({ title: '', feature_idea: '' })
      const user = await renderAtFinalStep()
      await user.click(screen.getByRole('button', { name: BRIEF }))

      expect(await screen.findByRole('alert')).toHaveTextContent(/no draft/i)
    })

    it('keeps a filled description when the draft fails', async () => {
      mockSuggestDocumentBrief.mockRejectedValue(new Error('API Error: 500'))
      const user = userEvent.setup()
      render(<StatefulDocWizard initial={{ title: 'Offline maps', featureIdea: 'Riders save maps' }} />, { wrapper: createWrapper() })
      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: BRIEF }))
      await user.click(screen.getByRole('button', { name: 'Improve with AI' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('API Error: 500')
      expect(screen.getByRole('textbox', { name: 'Feature Description' })).toHaveValue('Riders save maps')
      expect(screen.getByRole('textbox', { name: 'Feature/Product Title' })).toHaveValue('Offline maps')
    })

    it('asks before rewriting a title the user typed, and Cancel keeps it', async () => {
      const user = await renderAtFinalStep(makeProps({ title: 'My own title' }))
      await user.click(screen.getByRole('button', { name: BRIEF }))
      expect(screen.getByRole('dialog', { name: 'Rewrite your text with AI?' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(mockSuggestDocumentBrief).not.toHaveBeenCalled()
    })
  })

  describe('PR/FAQ answers assist', () => {
    const ANSWERS = /— the five answers$/

    it('is gated, with its reason, until title and description both exist', async () => {
      await renderAtFinalStep(makeProps({ title: 'Dark mode' }))
      const button = screen.getByRole('button', { name: ANSWERS })

      expect(button).toBeDisabled()
      expect(button).toHaveAccessibleDescription('Add a title and description first')
      expect(screen.getAllByRole('textbox', { name: /Who is the customer/i })[0]).toBeEnabled()
    })

    it('enables once the title and description are typed', async () => {
      const user = userEvent.setup()
      render(<StatefulDocWizard initial={{}} />, { wrapper: createWrapper() })
      await goToFinalStep(user)
      await user.type(screen.getByRole('textbox', { name: 'Feature/Product Title' }), 'Dark mode')
      expect(screen.getByRole('button', { name: ANSWERS })).toBeDisabled()
      await user.type(screen.getByRole('textbox', { name: 'Feature Description' }), 'Add a dark theme')

      expect(screen.getByRole('button', { name: ANSWERS })).toBeEnabled()
    })

    it('sends the title, description and typed answers, and keeps a typed answer the AI left blank', async () => {
      mockAutofillPrfaqQuestions.mockResolvedValue({ answers: ['', 'a2', 'a3', 'a4', 'a5'] })
      const props = makeProps({ title: 'Dark mode', featureIdea: 'Add dark theme', customerQuestions: ['Night readers', '', '', '', ''] })
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: ANSWERS }))
      await user.click(screen.getByRole('button', { name: 'Improve with AI' }))

      await waitFor(() => expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ customerQuestions: ['Night readers', 'a2', 'a3', 'a4', 'a5'] }),
      ))
      expect(mockAutofillPrfaqQuestions).toHaveBeenCalledWith('proj-1', expect.objectContaining({
        title: 'Dark mode', feature_idea: 'Add dark theme', answers: ['Night readers', '', '', '', ''],
      }))
    })

    it('pads short answer lists to five entries', async () => {
      mockAutofillPrfaqQuestions.mockResolvedValue({ answers: ['only one'] })
      const props = makeProps({ title: 'T', featureIdea: 'F' })
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: ANSWERS }))

      await waitFor(() => expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ customerQuestions: ['only one', '', '', '', ''] }),
      ))
    })

    it('shows the error when the draft fails', async () => {
      mockAutofillPrfaqQuestions.mockRejectedValue(new Error('Autofill exploded'))
      const user = await renderAtFinalStep(makeProps({ title: 'T', featureIdea: 'F' }))
      await user.click(screen.getByRole('button', { name: ANSWERS }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Autofill exploded')
    })

    it('asks before rewriting answers the user typed', async () => {
      const user = await renderAtFinalStep(makeProps({ title: 'T', featureIdea: 'F', customerQuestions: ['mine', '', '', '', ''] }))
      await user.click(screen.getByRole('button', { name: ANSWERS }))
      expect(screen.getByRole('dialog', { name: 'Rewrite your text with AI?' })).toHaveTextContent(/answers you typed/)
      expect(mockAutofillPrfaqQuestions).not.toHaveBeenCalled()
    })
  })
})
