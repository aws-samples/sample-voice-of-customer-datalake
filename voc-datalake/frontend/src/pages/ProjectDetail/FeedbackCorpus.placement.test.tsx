/**
 * @fileoverview Where the corpus line shows (#236): on a persona's detail header and under a
 * document's provenance, counted from `input_feedback_ids` (never the display-only
 * `source_feedback_ids`), and nowhere for an artefact that predates the field. The wire boundary
 * keeps the ids and drops non-string junk.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeProjectDetail } from '../../api/projectDetailSchema'
import DocumentsTab from './DocumentsTab'
import PersonaDetailView from './PersonaDetailView'
import { documentsTabStubs, makeProject } from './project-detail-fixtures'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ProjectDocument } from '../../api/types'

vi.mock('../../api/projectsApi', () => ({ projectsApi: { regeneratePersonaAvatar: vi.fn() } }))

const project = makeProject({
  project_id: 'proj-1', name: 'Example Air research', description: '',
  created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-05T00:00:00Z',
})

function renderPersona(persona: ProjectPersona) {
  return renderWithQueryClient(
    <PersonaDetailView projectId="proj-1" persona={persona} canEdit={false}
      onEdit={vi.fn()} onDelete={vi.fn()} onSaveNotes={vi.fn()} isDeleting={false} isSavingNotes={false} />,
  )
}

function renderDocument(doc: ProjectDocument) {
  return renderWithQueryClient(
    <MemoryRouter>
      <DocumentsTab project={project} documents={[doc]} selectedDoc={doc} onSelectDoc={vi.fn()} {...documentsTabStubs()} />
    </MemoryRouter>,
  )
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

  it('counts the ids a document was generated from', () => {
    renderDocument({ ...PRD, input_feedback_ids: ['f1'] })
    expect(screen.getByTestId('feedback-corpus')).toHaveTextContent('Written from 1 review')
  })

  it('is absent on a hand-written document', () => {
    renderDocument(PRD)
    expect(screen.queryByTestId('feedback-corpus')).toBeNull()
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
