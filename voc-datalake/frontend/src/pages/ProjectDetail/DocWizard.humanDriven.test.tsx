/**
 * DocWizard for a Human-driven person (docs/ways-of-working.md): the AI draft buttons give way
 * to the coaching notice, the submit becomes "Start writing" (only a title is needed), and it
 * files one hand-written blank-template document per selected type, then opens the first.
 * An unlocked type, or any other mode, keeps the generate path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { baseWizardProps, createWizardWrapper, resetWizardMocks } from './wizard-fixtures'
import { wizardApiClientMock, wizardConfigStoreMock } from '../../components/DataSourceWizard/dataSourceWizard-fixtures'
import type { AiMode } from '../../api/aiModeApi'
import type { DocToolConfig } from './types'

interface HandWritten { readonly document_type: string; readonly title: string; readonly create_id: string }
const startHandWrittenDocument = vi.fn<(projectId: string, data: HandWritten) => Promise<unknown>>()
const aiMode: { current: AiMode } = vi.hoisted(() => ({ current: { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false } }))

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    suggestDocumentBrief: vi.fn(),
    autofillPrfaqQuestions: vi.fn(),
    startHandWrittenDocument: (projectId: string, data: HandWritten) => startHandWrittenDocument(projectId, data),
  },
}))
vi.mock('../../hooks/useMyAiMode', () => ({ useMyAiMode: () => aiMode.current }))
vi.mock('../../api/client', () => wizardApiClientMock())
vi.mock('../../store/configStore', () => wizardConfigStoreMock())

const { DocWizard } = await import('./DocWizard')

const HUMAN: AiMode = { mode: 'human_driven', ai_writing_prfaq: false, ai_writing_prd: false }

function docConfig(docTypes: DocToolConfig['docTypes'], title = 'Faster refunds'): DocToolConfig {
  return { docTypes, title, featureIdea: '', customerQuestions: ['', '', '', '', ''] }
}

async function atFinalStep(config: DocToolConfig) {
  const user = userEvent.setup()
  const props = { ...baseWizardProps(), docConfig: config, onDocConfigChange: vi.fn(), onOpenDocument: vi.fn() }
  render(<DocWizard {...props} />, { wrapper: createWizardWrapper() })
  while (!screen.queryByText(/document type/i)) {
    await user.click(screen.getByRole('button', { name: /next/i }))
  }
  return { user, props }
}

beforeEach(() => {
  resetWizardMocks()
  aiMode.current = HUMAN
  startHandWrittenDocument.mockImplementation((_projectId, data) =>
    Promise.resolve({ success: true, document: { document_id: `doc_${data.document_type}` } }))
})

describe('DocWizard, Human-driven', () => {
  it('replaces the AI draft buttons with the coaching notice', async () => {
    await atFinalStep(docConfig(['prfaq']))

    expect(screen.getByRole('note')).toHaveTextContent('Human-driven: you write, AI coaches.')
    expect(screen.queryByRole('button', { name: /Draft with AI/ })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Write it yourself')
  })

  it('starts writing with only a title, filing one blank document per selected type and opening the first', async () => {
    const { user, props } = await atFinalStep(docConfig(['prfaq', 'prd'], '  Faster refunds '))

    await user.click(screen.getByRole('button', { name: /Start writing/ }))

    await waitFor(() => expect(props.onOpenDocument).toHaveBeenCalledWith('doc_prfaq'))
    const sent = startHandWrittenDocument.mock.calls.map(([projectId, data]) => ({ projectId, ...data }))
    expect(sent).toMatchObject([
      { projectId: 'proj-1', document_type: 'prfaq', title: 'Faster refunds' },
      { projectId: 'proj-1', document_type: 'prd', title: 'Faster refunds' },
    ])
    // One click id for the pair, a distinct create_id per type (a retry files each once).
    expect(sent.map((call) => call.create_id.replace(/_(prfaq|prd)$/, ''))).toSatisfy(
      (ids: string[]) => ids.length === 2 && ids[0] === ids[1] && /^[0-9a-f]{32}$/.test(ids[0] ?? ''),
    )
    expect([props.onSubmit.mock.calls.length, props.onClose.mock.calls.length]).toStrictEqual([0, 1])
  })

  it('needs a title before it can start', async () => {
    await atFinalStep(docConfig(['prfaq'], ''))

    expect(screen.getByRole('button', { name: /Start writing/ })).toBeDisabled()
  })

  it('says when the document could not be created, keeping the wizard open', async () => {
    startHandWrittenDocument.mockRejectedValue(new Error('API Error: 500'))
    const { user, props } = await atFinalStep(docConfig(['prd']))

    await user.click(screen.getByRole('button', { name: /Start writing/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The document could not be created. Try again.')
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe('DocWizard, AI allowed', () => {
  it('keeps the generate path for a type an admin unlocked', async () => {
    aiMode.current = { ...HUMAN, ai_writing_prd: true }
    await atFinalStep(docConfig(['prd']))

    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Generate PRD')
  })

  it('switches the whole wizard to writing by hand when any selected type is locked', async () => {
    aiMode.current = { ...HUMAN, ai_writing_prd: true }
    await atFinalStep(docConfig(['prfaq', 'prd']))

    expect(screen.getByRole('button', { name: /Start writing/ })).toBeInTheDocument()
  })

  it('keeps the generate path for AI-assisted', async () => {
    aiMode.current = { ...HUMAN, mode: 'ai_assisted' }
    await atFinalStep(docConfig(['prfaq']))

    expect(screen.getByRole('button', { name: /Generate PR\/FAQ/ })).toBeInTheDocument()
  })
})
