/**
 * Tests for matching a prioritization row to the feedback forms that validate it.
 *
 * The load-bearing behaviour here is that `project_id` is matched first and
 * `document_id` is only a refinement: regenerating a document mints a new id, so
 * a link stored against the old id must not silently detach.
 */
import { describe, it, expect } from 'vitest'
import {
  buildLinkedFormsByDocument, collectProjectDocumentIds, normalizeLinkedForms, selectLinkedForms,
} from './formLinkUtils'
import type { LinkedForm } from './formLinkUtils'
import type { Project, ProjectDocument } from '../../api/types'

function form(overrides: Partial<LinkedForm> & { form_id: string }): LinkedForm {
  return {
    name: 'A form',
    project_id: '',
    document_id: '',
    ...overrides,
  }
}

const liveDocs = new Set(['doc_prfaq', 'doc_prd'])

describe('selectLinkedForms', () => {
  it('matches a form pinned to this exact document', () => {
    const pinned = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_prfaq' })

    const matched = selectLinkedForms([pinned], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)

    expect(matched).toEqual([pinned])
  })

  it('returns nothing for a row with no linked form', () => {
    const elsewhere = form({ form_id: 'f1', project_id: 'p2', document_id: 'doc_other' })

    const matched = selectLinkedForms([elsewhere], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)

    expect(matched).toEqual([])
  })

  it('never matches an unlinked standalone survey to any row', () => {
    // The whole point of the fields being optional: a website form validates
    // nothing and must stay off this page.
    const standalone = form({ form_id: 'f1', name: 'Website Footer Form' })

    expect(selectLinkedForms([standalone], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)).toEqual([])
  })

  it('returns every form validating the same document', () => {
    const first = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_prfaq' })
    const second = form({ form_id: 'f2', project_id: 'p1', document_id: 'doc_prfaq' })

    const matched = selectLinkedForms([first, second], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)

    expect(matched.map((f) => f.form_id)).toEqual(['f1', 'f2'])
  })

  it('matches a project-wide link (no document_id) on every scorable row', () => {
    const projectWide = form({ form_id: 'f1', project_id: 'p1' })

    expect(selectLinkedForms([projectWide], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs))
      .toEqual([projectWide])
    expect(selectLinkedForms([projectWide], { project_id: 'p1', document_id: 'doc_prd' }, liveDocs))
      .toEqual([projectWide])
  })

  it('keeps showing a form whose document was regenerated', () => {
    // The regression this fallback exists for: 'doc_old' is gone from the
    // project, so the link would otherwise resolve to nothing and the collected
    // evidence would disappear from the page.
    const stale = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_old' })

    const matched = selectLinkedForms([stale], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)

    expect(matched).toEqual([stale])
  })

  it('does not show a document-pinned form on a live sibling document', () => {
    // Without this, the PR/FAQ's ratings would also appear on the PRD row.
    const pinnedToSibling = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_prd' })

    const matched = selectLinkedForms([pinnedToSibling], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)

    expect(matched).toEqual([])
  })

  it('prefers the exact document match over the project fallback', () => {
    const exact = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_prfaq' })
    const projectWide = form({ form_id: 'f2', project_id: 'p1' })

    const matched = selectLinkedForms([exact, projectWide], { project_id: 'p1', document_id: 'doc_prfaq' }, liveDocs)

    expect(matched.map((f) => f.form_id)).toEqual(['f1'])
  })

  it('treats no link as stale while the project detail is still loading', () => {
    // liveDocumentIds undefined: matching on the project is the safe read, so
    // evidence appears rather than flickering to "no linked form".
    const pinned = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_old' })

    expect(selectLinkedForms([pinned], { project_id: 'p1', document_id: 'doc_prfaq' })).toEqual([pinned])
  })
})

describe('normalizeLinkedForms', () => {
  it('reads a stored link off a wire record', () => {
    const [normalized] = normalizeLinkedForms([
      { form_id: 'f1', name: 'PR/FAQ validation', project_id: 'p1', document_id: 'doc_prfaq' },
    ])

    expect(normalized.project_id).toBe('p1')
    expect(normalized.document_id).toBe('doc_prfaq')
  })

  it('defaults the link to unlinked on a record that predates the fields', () => {
    const [normalized] = normalizeLinkedForms([{ form_id: 'f1', name: 'Legacy Form' }])

    expect(normalized.project_id).toBe('')
    expect(normalized.document_id).toBe('')
  })

  it('degrades a wrong-typed link to unlinked rather than dropping the form', () => {
    const [normalized] = normalizeLinkedForms([{ form_id: 'f1', project_id: 42, document_id: null }])

    expect(normalized.project_id).toBe('')
    expect(normalized.document_id).toBe('')
  })

  it('drops records without a usable form_id — it keys the stats query', () => {
    expect(normalizeLinkedForms([{ name: 'No identity' }, { form_id: '' }, 'nonsense', null])).toEqual([])
  })
})

describe('collectProjectDocumentIds', () => {
  it('indexes each project\'s document ids by project_id', () => {
    const project = (id: string): Project => ({
      project_id: id,
      name: id.toUpperCase(),
      description: '',
      status: 'active',
      created_at: '',
      updated_at: '',
      persona_count: 0,
      document_count: 0,
    })
    const document = (id: string): ProjectDocument => ({
      document_id: id,
      document_type: 'prfaq',
      title: id,
      content: '',
      created_at: '',
    })

    const byProject = collectProjectDocumentIds(
      [
        { documents: [document('doc_a'), document('doc_b')] },
        { documents: [document('doc_c')] },
      ],
      [project('p1'), project('p2')],
    )

    expect([...(byProject.get('p1') ?? [])]).toEqual(['doc_a', 'doc_b'])
    expect([...(byProject.get('p2') ?? [])]).toEqual(['doc_c'])
  })

  it('returns an empty index before the data has loaded', () => {
    expect(collectProjectDocumentIds(undefined, undefined).size).toBe(0)
  })
})

describe('buildLinkedFormsByDocument', () => {
  it('keys each row\'s forms by document_id', () => {
    const pinned = form({ form_id: 'f1', project_id: 'p1', document_id: 'doc_prfaq' })
    const rows = [
      { project_id: 'p1', document_id: 'doc_prfaq' },
      { project_id: 'p1', document_id: 'doc_prd' },
    ]

    const byDocument = buildLinkedFormsByDocument([pinned], rows, new Map([['p1', liveDocs]]))

    expect(byDocument.get('doc_prfaq')).toEqual([pinned])
    expect(byDocument.get('doc_prd')).toEqual([])
  })
})
