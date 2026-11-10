/**
 * @fileoverview `editsFor`: which calls a draft needs. Only what changed, and
 * visibility only for a manager, because PUT /projects/{id}/visibility is a
 * manage-level route the gate refuses an editor.
 */
import { describe, expect, it } from 'vitest'
import { draftFrom, editsFor, hasEdits } from './editProject'
import type { Project } from '../../api/projectTypes'

const PROJECT: Project = {
  project_id: 'p1',
  name: 'Name',
  description: 'Desc',
  status: 'active',
  created_at: '',
  updated_at: '',
  persona_count: 0,
  document_count: 0,
  visibility: 'private',
}

describe('editsFor', () => {
  it('is empty for an untouched draft', () => {
    const edits = editsFor(PROJECT, draftFrom(PROJECT), true)
    expect(edits).toStrictEqual({})
    expect(hasEdits(edits)).toBe(false)
  })

  it('sends the trimmed name and a cleared description, and nothing unchanged', () => {
    const draft = { ...draftFrom(PROJECT), name: '  New  ', description: '' }
    expect(editsFor(PROJECT, draft, false)).toStrictEqual({ fields: { name: 'New', description: '' } })
  })

  it('counts whitespace-only changes to the name as no change', () => {
    expect(editsFor(PROJECT, { ...draftFrom(PROJECT), name: ' Name ' }, false)).toStrictEqual({})
  })

  it('drops a visibility change for a caller who cannot manage', () => {
    const draft = { ...draftFrom(PROJECT), visibility: 'public' as const }
    expect(editsFor(PROJECT, draft, false)).toStrictEqual({})
    expect(editsFor(PROJECT, draft, true)).toStrictEqual({ visibility: 'public' })
  })

  it('reads a legacy project without visibility as public', () => {
    const legacy: Project = { ...PROJECT, visibility: undefined }
    expect(draftFrom(legacy).visibility).toBe('public')
    expect(editsFor(legacy, draftFrom(legacy), true)).toStrictEqual({})
  })

  it('needs no call at all for an invalid (blank) name', () => {
    const edits = editsFor(PROJECT, { ...draftFrom(PROJECT), name: '   ', description: 'changed' }, true)
    expect(hasEdits(edits)).toBe(false)
  })
})
