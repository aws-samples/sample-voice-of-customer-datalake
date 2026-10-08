/**
 * @fileoverview Tests for PersonaWizard (Wizards.tsx) — U8's N1: the wizard used
 * to offer data sources the persona generator cannot read.
 *
 * `generatePersonas` sends feedback filters, a persona count and custom
 * instructions. Nothing else. But the shared wizard was rendered with `personas`
 * and `documents`, so it showed Personas / Documents / Research toggles and item
 * pickers, and the context summary reported the selection back — inputs the
 * mutation then dropped on the floor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '../../lib/errors'
import {
  createWizardWrapper, resetWizardMocks,
} from './wizard-fixtures'
import {
  wizardApiClientMock, wizardConfigStoreMock,
} from '../../components/DataSourceWizard/dataSourceWizard-fixtures'
import { makeDocument, makePersona } from './project-detail-fixtures'
import { defaultContextConfig } from '../../components/DataSourceWizard/types'
import { PersonaWizard, ResearchWizard } from './Wizards'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'

vi.mock('../../api/client', () => wizardApiClientMock())
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestResearchQuestions: vi.fn().mockResolvedValue({ suggestions: [] }),
  },
}))
vi.mock('../../store/configStore', () => wizardConfigStoreMock())

const createWrapper = createWizardWrapper

const personas: ProjectPersona[] = [
  makePersona({ persona_id: 'p1', name: 'Power User', tagline: 'Uses all features' }),
  makePersona({ persona_id: 'p2', name: 'Casual User', tagline: 'Basic usage' }),
]

const documents: ProjectDocument[] = [
  makeDocument({ document_id: 'd1', document_type: 'prd', title: 'A PRD' }),
  makeDocument({ document_id: 'd2', document_type: 'research', title: 'Some research' }),
]

function personaProps() {
  return {
    personas,
    documents,
    contextConfig: defaultContextConfig,
    personaConfig: { personaCount: 3, customInstructions: '' },
    generating: null,
    onContextChange: vi.fn(),
    onPersonaConfigChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }
}

describe('PersonaWizard data sources', () => {
  beforeEach(resetWizardMocks)

  it('offers customer feedback', async () => {
    render(<PersonaWizard {...personaProps()} />, { wrapper: createWrapper() })

    expect(await screen.findByText('Customer Feedback')).toBeInTheDocument()
  })

  it('does not offer personas, documents or research, which the generator discards', async () => {
    // The project passed in HAS two personas, a PRD and a research doc, so all
    // three cards would render if they were not hidden — that is what makes the
    // assertion meaningful rather than a restatement of an empty fixture.
    render(<PersonaWizard {...personaProps()} />, { wrapper: createWrapper() })

    await screen.findByText('Customer Feedback')
    expect(screen.queryByText('Personas (2)')).not.toBeInTheDocument()
    expect(screen.queryByText('Existing Documents (1)')).not.toBeInTheDocument()
    expect(screen.queryByText('Research Documents (1)')).not.toBeInTheDocument()
  })

  it('still offers personas in the research wizard, which can read them', async () => {
    // Guards against fixing N1 by hiding the sources for every wizard: research is
    // the step personas exist to ground.
    render(
      <ResearchWizard
        projectId="proj-1"
        personas={personas}
        documents={documents}
        contextConfig={defaultContextConfig}
        researchConfig={{ question: '', title: '', useWebSearch: false }}
        generating={null}
        onContextChange={vi.fn()}
        onResearchConfigChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
      { wrapper: createWrapper() },
    )

    await waitFor(() => {
      expect(screen.getByText('Personas (2)')).toBeInTheDocument()
    })
  })
})

/** Walk the shared wizard from its first step to the final one (where Generate lives). */
async function reachFinalStep(user: ReturnType<typeof userEvent.setup>, stepsLeft = 5): Promise<void> {
  const next = screen.queryByRole('button', { name: /^next/i })
  if (next === null || stepsLeft === 0) return
  await user.click(next)
  await reachFinalStep(user, stepsLeft - 1)
}

describe('PersonaWizard start failure (F1)', () => {
  beforeEach(resetWizardMocks)

  it('shows the server\'s reason when the start was refused (no feedback for the filters)', async () => {
    const user = userEvent.setup()
    render(
      <PersonaWizard {...personaProps()} startError={new ApiError(400, 'No feedback data found for the given filters')} />,
      { wrapper: createWrapper() },
    )
    await screen.findByText('Customer Feedback')
    await reachFinalStep(user)

    expect(await screen.findByRole('alert')).toHaveTextContent('No feedback data found for the given filters')
  })

  it('falls back to a retry line when the failure carries no server reason', async () => {
    const user = userEvent.setup()
    render(<PersonaWizard {...personaProps()} startError={new ApiError(502)} />, { wrapper: createWrapper() })
    await screen.findByText('Customer Feedback')
    await reachFinalStep(user)

    const alert = await screen.findByRole('alert')
    expect(alert).not.toHaveTextContent('API Error')
    expect(alert).toHaveTextContent('This could not be started. Try again.')
  })

  it('shows nothing before a failed attempt', async () => {
    const user = userEvent.setup()
    render(<PersonaWizard {...personaProps()} />, { wrapper: createWrapper() })
    await screen.findByText('Customer Feedback')
    await reachFinalStep(user)

    expect(screen.getByText(/Number of Personas/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
