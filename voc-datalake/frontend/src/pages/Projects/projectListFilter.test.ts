import { describe, expect, it } from 'vitest'
import { viewProjects } from './projectListFilter'
import type { Project } from '../../api/projectTypes'

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  project_id: id, name, description: '', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '',
  persona_count: 0, document_count: 0, ...extra,
})

const OWNED = project('a', 'Checkout revamp', { access: { role: 'owner', can_view: true, can_edit: true, can_manage: true }, updated_at: '2026-03-01T00:00:00Z' })
const SHARED = project('b', 'billing pains', { description: 'Refund delays', access: { role: 'editor', can_view: true, can_edit: true, can_manage: false }, updated_at: '2026-05-01T00:00:00Z' })
const LEGACY = project('c', 'Archive notes')
const ALL = [OWNED, SHARED, LEGACY]
const ids = (list: readonly Project[]) => list.map((p) => p.project_id)

describe('viewProjects', () => {
  it('"Mine" is what the caller owns; "Shared with me" is everything else they see', () => {
    expect(ids(viewProjects(ALL, { q: '', scope: 'mine', sort: 'updated' }))).toStrictEqual(['a'])
    expect(ids(viewProjects(ALL, { q: '', scope: 'shared', sort: 'updated' }))).toStrictEqual(['b', 'c'])
  })

  it('searches name and description, case-insensitively', () => {
    expect(ids(viewProjects(ALL, { q: 'REFUND', scope: 'all', sort: 'updated' }))).toStrictEqual(['b'])
  })

  it('sorts by most recently updated (created when never updated), or by name ignoring case', () => {
    expect(ids(viewProjects(ALL, { q: '', scope: 'all', sort: 'updated' }))).toStrictEqual(['b', 'a', 'c'])
    expect(ids(viewProjects(ALL, { q: '', scope: 'all', sort: 'name' }))).toStrictEqual(['c', 'b', 'a'])
  })

  it('never reorders the list it was given', () => {
    viewProjects(ALL, { q: '', scope: 'all', sort: 'name' })
    expect(ids(ALL)).toStrictEqual(['a', 'b', 'c'])
  })
})
