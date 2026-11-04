/**
 * @fileoverview The erased-evidence note: a persona or document whose cited reviews `voc-retention` erased
 * (`erased_evidence`, written by lambda/jobs/retention/lineage.py) says how many, and nothing else. The wire
 * boundary keeps only a positive whole `count`.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizePersona, normalizeProjectDocument } from '../../api/projectDetailSchema'
import DocumentsTab from './DocumentsTab'
import { renderPersonaDetail } from './persona-detail-fixtures'
import { documentsTabStubs, makeProject } from './project-detail-fixtures'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ProjectDocument } from '../../api/types'

vi.mock('../../api/projectsApi', () => ({ projectsApi: { regeneratePersonaAvatar: vi.fn() } }))

const project = makeProject({
  project_id: 'proj-1', name: 'Example Air research', description: '',
  created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-05T00:00:00Z',
})
const MARK = { count: 3, job_id: 'er_1', mode: 'erase', at: '2026-06-01T00:00:00Z' }
const PERSONA: ProjectPersona = { persona_id: 'persona_1', name: 'Ada', tagline: 'Flies weekly', created_at: '' }
const PRD: ProjectDocument = { document_id: 'prd_1', document_type: 'prd', title: 'Rebooking PRD', content: 'Body', created_at: '' }

function renderDocument(doc: ProjectDocument) {
  return renderWithQueryClient(
    <MemoryRouter>
      <DocumentsTab project={project} documents={[doc]} selectedDoc={doc} onSelectDoc={vi.fn()} {...documentsTabStubs()} />
    </MemoryRouter>,
  )
}

describe('the erased-evidence note', () => {
  it('shows the count on a persona, even when every listed review was erased', () => {
    renderPersonaDetail({ ...PERSONA, input_feedback_ids: [], erased_evidence: { count: 3 } }, { canEdit: false })
    expect(screen.getByTestId('erased-evidence')).toHaveTextContent('3 cited reviews were erased (legal basis recorded)')
  })

  it('shows the singular on a document', () => {
    renderDocument({ ...PRD, input_feedback_ids: ['f1'], erased_evidence: { count: 1 } })
    expect(screen.getByTestId('erased-evidence')).toHaveTextContent('1 cited review was erased (legal basis recorded)')
  })

  it('is absent without a mark', () => {
    renderDocument(PRD)
    expect(screen.queryByTestId('erased-evidence')).toBeNull()
  })
})

describe('the wire boundary', () => {
  it('keeps only the count of a stored mark', () => {
    expect(normalizePersona({ ...PERSONA, erased_evidence: MARK })?.erased_evidence).toStrictEqual({ count: 3 })
    expect(normalizeProjectDocument({ ...PRD, erased_evidence: MARK })?.erased_evidence).toStrictEqual({ count: 3 })
  })

  it.each([[{ count: 0 }], [{ count: 1.5 }], [{ count: '3' }], [{}], ['3'], [null]])('drops an unusable mark %j', (mark) => {
    expect(normalizePersona({ ...PERSONA, erased_evidence: mark })?.erased_evidence).toBeUndefined()
    expect(normalizeProjectDocument({ ...PRD, erased_evidence: mark })?.erased_evidence).toBeUndefined()
  })

  it('leaves the key out of a row without one', () => {
    expect(Object.hasOwn(normalizePersona(PERSONA) ?? {}, 'erased_evidence')).toBe(false)
  })
})
