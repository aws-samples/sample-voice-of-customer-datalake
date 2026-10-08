/**
 * @fileoverview Tests for DataSourceWizard component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { Sparkles } from 'lucide-react'
import { renderWithQueryClient } from '../../test/query-client'
import DataSourceWizard from './DataSourceWizard'
import { defaultContextConfig } from './types'
import {
  contextConfig, wizardApiMocks, wizardDocuments, wizardPersonas,
} from './dataSourceWizard-fixtures'

// Mock API before importing component
vi.mock('../../api/client', () => import('./dataSourceWizard-fixtures').then(m => m.wizardApiClientMock()))
vi.mock('../../store/configStore', () => import('./dataSourceWizard-fixtures').then(m => m.wizardConfigStoreMock()))

const defaultProps = {
  title: 'Test Wizard',
  accentColor: 'accent' as const,
  icon: <Sparkles data-testid="wizard-icon" />,
  personas: wizardPersonas,
  documents: wizardDocuments,
  contextConfig: defaultContextConfig,
  onContextChange: vi.fn(),
  renderFinalStep: () => <div data-testid="final-step">Final Step Content</div>,
  finalStepValid: true,
  onClose: vi.fn(),
  onSubmit: vi.fn(),
  isSubmitting: false,
  submitLabel: 'Generate',
}

type WizardProps = Partial<Parameters<typeof DataSourceWizard>[0]>

/** Mount the wizard with `defaultProps` plus `overrides`. */
function renderWizard(overrides: WizardProps = {}) {
  return renderWithQueryClient(<DataSourceWizard {...defaultProps} {...overrides} />)
}

/** Mount the wizard and press Next once. */
async function renderAndGoNext(overrides: WizardProps = {}): Promise<UserEvent> {
  const user = userEvent.setup()
  renderWizard(overrides)
  await user.click(screen.getByRole('button', { name: /next/i }))
  return user
}

/** Mount with feedback disabled (two steps) and go straight to the final step. */
async function renderAtFinalStep(overrides: WizardProps = {}): Promise<UserEvent> {
  return renderAndGoNext({ contextConfig: contextConfig({ useFeedback: false }), ...overrides })
}

const expectStep = (step: number) => waitFor(() => {
  expect(screen.getByText(new RegExp(`step ${step} of`, 'i'))).toBeInTheDocument()
})

describe('DataSourceWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wizardApiMocks.getSources.mockResolvedValue({ sources: { webscraper: 100, manual_import: 50 } })
    wizardApiMocks.getCategoriesConfig.mockResolvedValue({
      categories: [
        { id: 'delivery', name: 'delivery', description: 'Delivery Issues' },
        { id: 'quality', name: 'quality', description: 'Product Quality' },
      ],
    })
  })

  describe('header', () => {
    it('displays wizard title, step indicator and icon', () => {
      renderWizard()

      expect(screen.getByText('Test Wizard')).toBeInTheDocument()
      expect(screen.getByText(/step 1 of/i)).toBeInTheDocument()
      expect(screen.getByTestId('wizard-icon')).toBeInTheDocument()
    })

    it('displays close button', () => {
      renderWizard()

      expect(screen.getByLabelText('Close wizard')).toBeInTheDocument()
    })
  })

  describe('close functionality', () => {
    it('calls onClose when close button is clicked', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      renderWizard({ onClose })

      await user.click(screen.getByLabelText('Close wizard'))

      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('data sources step', () => {
    it('displays Customer Feedback option', () => {
      renderWizard()

      expect(screen.getByText('Customer Feedback')).toBeInTheDocument()
    })

    it('displays Personas option with its count when personas exist', () => {
      renderWizard()

      // The component shows "Personas (2)" format
      expect(screen.getByText(/Personas/)).toBeInTheDocument()
      expect(screen.getByText(/\(2\)/)).toBeInTheDocument()
    })

    it.each([
      ['feedback', /customer feedback/i, { useFeedback: true }, { useFeedback: false }],
      ['personas', /personas/i, {}, { usePersonas: true }],
    ])('calls onContextChange when the %s checkbox is toggled', async (_source, name, initial, expected) => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      renderWizard({ onContextChange, contextConfig: contextConfig(initial) })

      await user.click(screen.getByRole('checkbox', { name }))

      expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining(expected))
    })
  })

  describe('navigation', () => {
    it('displays Back button disabled on first step', () => {
      renderWizard()

      expect(screen.getByRole('button', { name: /back/i })).toBeDisabled()
    })

    it('displays Next button on non-final steps', () => {
      renderWizard()

      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
    })

    it('advances to next step when Next is clicked', async () => {
      await renderAndGoNext()

      await expectStep(2)
    })

    it('goes back when Back is clicked', async () => {
      const user = await renderAndGoNext()
      await expectStep(2)

      await user.click(screen.getByRole('button', { name: /back/i }))

      await expectStep(1)
    })
  })

  describe('feedback filters step', () => {
    it.each([
      'Sources',
      'Categories',
      'Sentiments',
      'Time Range',
    ])('displays the %s section when feedback is enabled', async (heading) => {
      await renderAndGoNext({ contextConfig: contextConfig({ useFeedback: true }) })

      await waitFor(() => {
        expect(screen.getByText(heading)).toBeInTheDocument()
      })
    })
  })

  describe('final step', () => {
    it('renders custom final step content', async () => {
      // Only 2 steps when feedback is disabled
      await renderAtFinalStep()

      await waitFor(() => {
        expect(screen.getByTestId('final-step')).toBeInTheDocument()
      })
    })

    it('displays submit button on final step', async () => {
      await renderAtFinalStep()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument()
      })
    })

    it('calls onSubmit when submit button is clicked', async () => {
      const onSubmit = vi.fn()
      const user = await renderAtFinalStep({ onSubmit })
      const submit = await screen.findByRole('button', { name: /generate/i })

      await user.click(submit)

      expect(onSubmit).toHaveBeenCalledTimes(1)
    })

    it('disables submit button when finalStepValid is false', async () => {
      await renderAtFinalStep({ finalStepValid: false })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled()
      })
    })

    it('shows loading state when isSubmitting is true', async () => {
      await renderAtFinalStep({ isSubmitting: true })

      await waitFor(() => {
        expect(screen.getByText('Processing...')).toBeInTheDocument()
      })
    })
  })

  describe('progress bar', () => {
    it('displays progress bar', () => {
      renderWizard()

      expect(document.querySelector('.h-1.bg-border')).toBeInTheDocument()
    })
  })

  describe('accent colors', () => {
    it.each([
      ['purple', 'accent', 'bg-accent'],
      ['blue', 'info', 'bg-info'],
      ['amber', 'warn', 'bg-warn'],
      ['green', 'ok', 'bg-ok'],
    ] as const)('applies the %s accent color', (_hue, accentColor, className) => {
      renderWizard({ accentColor })

      expect(screen.getByRole('button', { name: /next/i })).toHaveClass(className)
    })
  })

  describe('hideDataSources and empty states', () => {
    it.each([
      ['hides feedback option when specified', { hideDataSources: ['feedback'] }, 'Customer Feedback'],
      ['hides personas option when specified', { hideDataSources: ['personas'] }, /personas \(/i],
      ['does not show personas option when no personas exist', { personas: [] }, /personas \(/i],
      ['does not show documents option when no documents exist', { documents: [] }, /existing documents/i],
    ] as const)('%s', (_title, overrides, absentText) => {
      renderWizard(overrides)

      expect(screen.queryByText(absentText)).not.toBeInTheDocument()
    })
  })
})
