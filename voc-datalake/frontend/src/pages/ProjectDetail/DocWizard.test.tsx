/**
 * @fileoverview Tests for DocWizard (Wizards.tsx) — the PRD/PR-FAQ doc-type
 * multi-select and the AI authoring assists (prd-fix #17-5/6, shipped in
 * PR #132 without dedicated coverage — added as the P8 test-coverage rider).
 */
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
      expect(dialog).toHaveAccessibleName('Generate PR-FAQ')
    })

    it('keeps the dialog name in step with the doc-type selection', () => {
      // Pins the name to the same value the heading shows, which is what makes the
      // exact assertion above meaningful rather than a hardcoded coincidence.
      renderWithDocTypes(['prfaq', 'prd'])

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Generate PRD + PR-FAQ')
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
    it('shows PR-FAQ title when only prfaq is selected', () => {
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })
      expect(screen.getByText('Generate PR-FAQ')).toBeInTheDocument()
    })

    it('shows combined title when both types are selected', () => {
      renderWithDocTypes(['prfaq', 'prd'])
      expect(screen.getByText('Generate PRD + PR-FAQ')).toBeInTheDocument()
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
      await user.click(screen.getByRole('button', { name: /PR-FAQ Amazon-style/i }))

      expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ docTypes: ['prd'] }),
      )
    })
  })

  describe('AI draft brief assist', () => {
    /** Walks to the final step and clicks the brief "AI draft" button. */
    async function clickAiDraft(props = makeProps()) {
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: /^AI draft$/i }))
    }

    it('fills title and feature idea from the suggestion', async () => {
      mockSuggestDocumentBrief.mockResolvedValue({
        title: 'Crash-free login',
        feature_idea: 'Fix the login crash.',
      })
      const props = makeProps()
      await clickAiDraft(props)

      await waitFor(() => {
        expect(props.onDocConfigChange).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Crash-free login',
            featureIdea: 'Fix the login crash.',
          }),
        )
      })
      expect(mockSuggestDocumentBrief).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ doc_type: 'prfaq' }),
      )
    })

    it('shows a hint when the model returns an empty draft', async () => {
      mockSuggestDocumentBrief.mockResolvedValue({ title: '', feature_idea: '' })
      await clickAiDraft()

      expect(await screen.findByText(/no draft/i)).toBeInTheDocument()
    })

    it('shows the error when the draft call fails', async () => {
      mockSuggestDocumentBrief.mockRejectedValue(new Error('API Error: 500'))
      await clickAiDraft()

      expect(await screen.findByText(/API Error: 500/i)).toBeInTheDocument()
    })
  })

  describe('PR-FAQ answers autofill assist', () => {
    /** Walks to the final step and clicks "AI draft answers". */
    async function clickAiDraftAnswers(props = makeProps()) {
      const user = await renderAtFinalStep(props)
      await user.click(screen.getByRole('button', { name: /AI draft answers/i }))
    }

    it('fills the five customer questions from the suggestion', async () => {
      mockAutofillPrfaqQuestions.mockResolvedValue({
        answers: ['a1', 'a2', 'a3', 'a4', 'a5'],
      })
      const props = makeProps({ title: 'Dark mode', featureIdea: 'Add dark theme' })
      await clickAiDraftAnswers(props)

      await waitFor(() => {
        expect(props.onDocConfigChange).toHaveBeenCalledWith(
          expect.objectContaining({ customerQuestions: ['a1', 'a2', 'a3', 'a4', 'a5'] }),
        )
      })
      expect(mockAutofillPrfaqQuestions).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ title: 'Dark mode', feature_idea: 'Add dark theme' }),
      )
    })

    it('pads short answer lists to five entries', async () => {
      mockAutofillPrfaqQuestions.mockResolvedValue({ answers: ['only one'] })
      const props = makeProps()
      await clickAiDraftAnswers(props)

      await waitFor(() => {
        expect(props.onDocConfigChange).toHaveBeenCalledWith(
          expect.objectContaining({ customerQuestions: ['only one', '', '', '', ''] }),
        )
      })
    })

    it('shows the error when autofill fails', async () => {
      mockAutofillPrfaqQuestions.mockRejectedValue(new Error('Autofill exploded'))
      await clickAiDraftAnswers()

      expect(await screen.findByText(/Autofill exploded/i)).toBeInTheDocument()
    })
  })
})
