/**
 * @fileoverview Where the corpus line shows (#236): on a persona's detail header and in a
 * document's evidence (the page's evidence cards, lazy-loaded with the page), counted from
 * `input_feedback_ids` (never the display-only `source_feedback_ids`), and nowhere for an artefact
 * that predates the field. The wire boundary keeps the ids and drops non-string junk.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeProjectDetail } from '../../api/projectDetailSchema'
import DocumentsTab from './DocumentsTab'
import { renderPersonaDetail } from './persona-detail-fixtures'
import { documentsTabStubs, makeProject, preloadDocumentPage } from './project-detail-fixtures'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ProjectDocument } from '../../api/types'

vi.mock('../../api/projectsApi', () => ({ projectsApi: { regeneratePersonaAvatar: vi.fn() } }))

const project = makeProject({
  project_id: 'proj-1', name: 'Example Air research', description: '',
  created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-05T00:00:00Z',
})

function renderPersona(persona: ProjectPersona) {
  return renderPersonaDetail(persona, { canEdit: false })
}

await preloadDocumentPage()

/** The document's evidence, once its lazy page has loaded. */
async function renderDocumentEvidence(doc: ProjectDocument) {
  renderWithQueryClient(
    <MemoryRouter>
      <DocumentsTab project={project} documents={[doc]} selectedDoc={doc} onSelectDoc={vi.fn()} {...documentsTabStubs()} />
    </MemoryRouter>,
  )
  return within(await screen.findByTestId('evidence-cards'))
}

const PERSONA: ProjectPersona = { persona_id: 'persona_1', name: 'Ada', tagline: 'Flies weekly', created_at: '' }
const PRD: ProjectDocument = { document_id: 'prd_1', document_type: 'prd', title: 'Rebooking PRD', content: 'Body', created_at: '' }

describe('the corpus line', () => {
  it('counts the ids a persona was written from', () => {
    renderPersona({ ...PERSONA, input_feedback_ids: ['f1', 'f2', 'f3'] })
    expect(screen.getByTestId('feedback-corpus')).toHaveTextContent('Written from 3 reviews')
  })

  it('is absent on a persona generated before the corpus was stored', () => {
    renderPersona(PERSONA)
    expect(screen.queryByTestId('feedback-corpus')).toBeNull()
  })

  it('counts the ids a document was generated from', async () => {
    const evidence = await renderDocumentEvidence({ ...PRD, input_feedback_ids: ['f1'] })
    expect(evidence.getByText('Written from 1 review')).toBeInTheDocument()
  })

  it('is absent on a hand-written document', async () => {
    const evidence = await renderDocumentEvidence(PRD)
    expect(evidence.queryByText(/Written from/)).toBeNull()
  })
})

describe('the project detail boundary', () => {
  it('keeps the string corpus ids of a persona and drops a malformed document list', () => {
    const detail = normalizeProjectDetail({
      project: { project_id: 'proj-1' },
      personas: [{ ...PERSONA, input_feedback_ids: ['f1', 7, 'f2'], source_feedback_ids: ['x'] }],
      documents: [{ ...PRD, input_feedback_ids: 'f1' }],
    })
    expect(detail.personas[0]?.input_feedback_ids).toStrictEqual(['f1', 'f2'])
    expect(detail.documents[0]?.input_feedback_ids).toBeUndefined()
  })
})

// The erased-evidence note (api/erasedEvidence.ts): cited reviews `voc-retention` erased, the count only.
describe('the erased-evidence note', () => {
  it('shows the count on a persona, even when every listed review was erased', () => {
    renderPersona({ ...PERSONA, input_feedback_ids: [], erased_evidence: { count: 3 } })
    expect(screen.getByTestId('erased-evidence')).toHaveTextContent('3 cited reviews or board requests were erased (legal basis recorded)')
  })

  it('shows the singular on a document', async () => {
    const evidence = await renderDocumentEvidence({ ...PRD, input_feedback_ids: ['f1'], erased_evidence: { count: 1 } })
    expect(evidence.getByTestId('erased-evidence')).toHaveTextContent('1 cited review or board request was erased (legal basis recorded)')
  })

  it('is absent without a mark', async () => {
    const evidence = await renderDocumentEvidence(PRD)
    expect(evidence.queryByTestId('erased-evidence')).toBeNull()
  })
})
