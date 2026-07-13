/**
 * @fileoverview Tests for DocWizard (Wizards.tsx) — the PRD/PR-FAQ doc-type
 * multi-select and the AI authoring assists (prd-fix #17-5/6, shipped in
 * PR #132 without dedicated coverage — added as the P8 test-coverage rider).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DocWizard } from './Wizards'
import { defaultContextConfig } from '../../components/DataSourceWizard/exports'
import type { DocToolConfig } from './types'

const mockSuggestDocumentBrief = vi.fn()
const mockAutofillPrfaqQuestions = vi.fn()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestDocumentBrief: (...args: unknown[]) => mockSuggestDocumentBrief(...args),
    autofillPrfaqQuestions: (...args: unknown[]) => mockAutofillPrfaqQuestions(...args),
  },
}))

const mockGetSources = vi.fn()
const mockGetCategoriesConfig = vi.fn()
vi.mock('../../api/client', () => ({
  api: {
    getSources: (days: number) => mockGetSources(days),
    getCategoriesConfig: () => mockGetCategoriesConfig(),
  },
}))
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const baseDocConfig: DocToolConfig = {
  docTypes: ['prfaq'],
  title: '',
  featureIdea: '',
  customerQuestions: ['', '', '', '', ''],
}

function makeProps(docConfig: Partial<DocToolConfig> = {}) {
  return {
    projectId: 'proj-1',
    personas: [],
    documents: [],
    contextConfig: defaultContextConfig,
    docConfig: { ...baseDocConfig, ...docConfig },
    generating: null,
    onContextChange: vi.fn(),
    onDocConfigChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }
}

/** Click Next until the final (doc-type) step is visible. */
async function goToFinalStep(user: ReturnType<typeof userEvent.setup>) {
  while (!screen.queryByText(/document type/i)) {
    await user.click(screen.getByRole('button', { name: /next/i }))
  }
}

describe('DocWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSources.mockResolvedValue({ sources: {} })
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
  })

  describe('doc-type multi-select', () => {
    it('shows PR-FAQ title when only prfaq is selected', () => {
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })
      expect(screen.getByText('Generate PR-FAQ')).toBeInTheDocument()
    })

    it('shows combined title when both types are selected', () => {
      render(
        <DocWizard {...makeProps({ docTypes: ['prfaq', 'prd'] })} />,
        { wrapper: createWrapper() },
      )
      expect(screen.getByText('Generate PRD + PR-FAQ')).toBeInTheDocument()
    })

    it('adds prd to the selection when its card is clicked (multi-select, not replace)', async () => {
      const user = userEvent.setup()
      const props = makeProps()
      render(<DocWizard {...props} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /PRD Product Requirements Document/i }))

      expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ docTypes: ['prfaq', 'prd'] }),
      )
    })

    it('removes a selected type when its card is clicked again', async () => {
      const user = userEvent.setup()
      const props = makeProps({ docTypes: ['prfaq', 'prd'] })
      render(<DocWizard {...props} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /PR-FAQ Amazon-style/i }))

      expect(props.onDocConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ docTypes: ['prd'] }),
      )
    })
  })

  describe('AI draft brief assist', () => {
    it('fills title and feature idea from the suggestion', async () => {
      const user = userEvent.setup()
      mockSuggestDocumentBrief.mockResolvedValue({
        title: 'Crash-free login',
        feature_idea: 'Fix the login crash.',
      })
      const props = makeProps()
      render(<DocWizard {...props} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /^AI draft$/i }))

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
      const user = userEvent.setup()
      mockSuggestDocumentBrief.mockResolvedValue({ title: '', feature_idea: '' })
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /^AI draft$/i }))

      expect(await screen.findByText(/no draft/i)).toBeInTheDocument()
    })

    it('shows the error when the draft call fails', async () => {
      const user = userEvent.setup()
      mockSuggestDocumentBrief.mockRejectedValue(new Error('API Error: 500'))
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /^AI draft$/i }))

      expect(await screen.findByText(/API Error: 500/i)).toBeInTheDocument()
    })
  })

  describe('PR-FAQ answers autofill assist', () => {
    it('fills the five customer questions from the suggestion', async () => {
      const user = userEvent.setup()
      mockAutofillPrfaqQuestions.mockResolvedValue({
        answers: ['a1', 'a2', 'a3', 'a4', 'a5'],
      })
      const props = makeProps({ title: 'Dark mode', featureIdea: 'Add dark theme' })
      render(<DocWizard {...props} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /AI draft answers/i }))

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
      const user = userEvent.setup()
      mockAutofillPrfaqQuestions.mockResolvedValue({ answers: ['only one'] })
      const props = makeProps()
      render(<DocWizard {...props} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /AI draft answers/i }))

      await waitFor(() => {
        expect(props.onDocConfigChange).toHaveBeenCalledWith(
          expect.objectContaining({ customerQuestions: ['only one', '', '', '', ''] }),
        )
      })
    })

    it('shows the error when autofill fails', async () => {
      const user = userEvent.setup()
      mockAutofillPrfaqQuestions.mockRejectedValue(new Error('Autofill exploded'))
      render(<DocWizard {...makeProps()} />, { wrapper: createWrapper() })

      await goToFinalStep(user)
      await user.click(screen.getByRole('button', { name: /AI draft answers/i }))

      expect(await screen.findByText(/Autofill exploded/i)).toBeInTheDocument()
    })
  })
})
