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
import { render, screen, waitFor, within } from '@testing-library/react'
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
    previewFeedback: vi.fn().mockResolvedValue({
      matched: 12, matched_is_lower_bound: false, sample_limit: 145, estimated: false,
    }),
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
    projectId: 'proj-1',
    personas,
    documents,
    contextConfig: defaultContextConfig,
    personaConfig: { personaCount: 3, customInstructions: '', mode: 'add' as const },
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

/** The wizard rendered with the two-persona project and walked to its final step. */
async function renderAtFinalStep(extra: { additiveOnly?: boolean; mode?: 'add' | 'replace' } = {}) {
  const base = personaProps()
  const props = { ...base, additiveOnly: extra.additiveOnly, personaConfig: { ...base.personaConfig, mode: extra.mode ?? 'add' } }
  const user = userEvent.setup()
  render(<PersonaWizard {...props} />, { wrapper: createWrapper() })
  await screen.findByText('Customer Feedback')
  await reachFinalStep(user)
  return { props, user }
}

/** Wave 4 live finding: the final "Generate Personas" started an AI job in one click (PR/FAQ and prototype ask first). */
describe('PersonaWizard asks before generating', () => {
  beforeEach(resetWizardMocks)

  async function openConfirm() {
    const { props, user } = await renderAtFinalStep()
    await user.click(screen.getByRole('button', { name: /Generate Personas/ }))
    return { props, user }
  }

  it('opens a confirmation naming the persona count, and does not start yet', async () => {
    const { props } = await openConfirm()
    expect(screen.getByRole('dialog', { name: 'Generate personas now?' })).toHaveTextContent('writes 3 personas')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('starts once on confirm', async () => {
    const { props, user } = await openConfirm()
    const dialog = screen.getByRole('dialog', { name: 'Generate personas now?' })
    await user.click(within(dialog).getByRole('button', { name: 'Generate Personas' }))
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
  })
})

/** #353: a project with personas chooses add (default) or replace on the final step. */
describe('PersonaWizard add-or-replace', () => {
  beforeEach(resetWizardMocks)

  it('offers the choice on the final step, add selected, and reports a switch to replace', async () => {
    const { props, user } = await renderAtFinalStep()

    expect(screen.getByRole('radio', { name: /Add to existing personas/ })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /Replace existing personas/ }))
    expect(props.onPersonaConfigChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replace' }))
  })
})

/** 5.60: the company library is only ever added to, so its wizard offers no replace. */
describe('PersonaWizard additive only (company library)', () => {
  beforeEach(resetWizardMocks)

  it('hides the add-or-replace choice', async () => {
    await renderAtFinalStep({ additiveOnly: true })
    expect(screen.queryByRole('radio', { name: /Replace existing personas/ })).not.toBeInTheDocument()
  })

  it('confirms as an addition even if the config says replace', async () => {
    const { user } = await renderAtFinalStep({ additiveOnly: true, mode: 'replace' })
    await user.click(screen.getByRole('button', { name: /Generate Personas/ }))
    expect(screen.getByRole('dialog', { name: 'Generate personas now?' })).toBeInTheDocument()
  })
})
