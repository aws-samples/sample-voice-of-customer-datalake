/**
 * @fileoverview The sharing fields at the project boundaries (list, detail,
 * create) and the members/candidates responses.
 *
 * The rule pinned throughout: a missing or malformed sharing field can only
 * HIDE controls — never grant edit or manage the server did not report.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeMemberCandidates, normalizeProject, normalizeProjectDetail, normalizeProjectList,
  normalizeProjectMember, normalizeProjectMembers,
} from './projectDetailSchema'
import { at } from '@test/defined'

const FAIL_CLOSED_ACCESS = { role: null, can_view: true, can_edit: false, can_manage: false }

const owner = { sub: 'sub-owner', username: 'owner', email: 'owner@example.com' }
const managerAccess = { role: 'owner', can_view: true, can_edit: true, can_manage: true }

describe('normalizeProjectList', () => {
  it('gives a legacy row (no sharing fields) public visibility and fail-closed access', () => {
    const { projects } = normalizeProjectList({ projects: [{ project_id: 'p1', name: 'Legacy' }] })

    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      project_id: 'p1',
      name: 'Legacy',
      visibility: 'public',
      owner: null,
      access: FAIL_CLOSED_ACCESS,
      member_count: 0,
    })
    expect(at(projects, 0).members).toBeUndefined()
  })

  it('keeps the sharing fields the API computed', () => {
    const { projects } = normalizeProjectList({
      projects: [{ project_id: 'p1', visibility: 'private', owner, access: managerAccess, member_count: 3 }],
    })

    expect(projects[0]).toMatchObject({ visibility: 'private', owner, access: managerAccess, member_count: 3 })
  })

  it('falls back field-by-field on malformed sharing values', () => {
    const { projects } = normalizeProjectList({
      projects: [{
        project_id: 'p1',
        visibility: 'secret',
        owner: { username: 'no-sub' },
        access: { role: 'superuser', can_view: true, can_edit: 'yes', can_manage: true },
        member_count: -1,
      }],
    })

    expect(projects[0]).toMatchObject({
      visibility: 'public',
      owner: null,
      // Only the malformed leaves fall back; a well-formed can_manage is kept.
      access: { role: null, can_view: true, can_edit: false, can_manage: true },
      member_count: 0,
    })
  })

  it('replaces a non-object access with the fail-closed default', () => {
    const { projects } = normalizeProjectList({ projects: [{ project_id: 'p1', access: 'owner' }] })
    expect(at(projects, 0).access).toStrictEqual(FAIL_CLOSED_ACCESS)
  })

  it('drops rows without a usable project_id and tolerates a non-array list', () => {
    expect(normalizeProjectList({ projects: [{ name: 'no id' }, 'junk', { project_id: 'ok' }] })
      .projects.map((p) => p.project_id)).toStrictEqual(['ok'])
    expect(normalizeProjectList({ projects: 'nope' }).projects).toStrictEqual([])
    expect(normalizeProjectList(null).projects).toStrictEqual([])
  })
})

describe('normalizeProjectDetail sharing fields', () => {
  it('normalizes members, dropping rows without a sub and defaulting an unknown role to viewer', () => {
    const detail = normalizeProjectDetail({
      project: {
        project_id: 'p1',
        members: [
          { sub: 's1', role: 'editor', username: 'ed', email: 'ed@example.com', added_by: 'sub-owner' },
          { sub: 's2', role: 'owner', username: 'odd' },
          { role: 'viewer', username: 'no-sub' },
        ],
      },
      personas: [],
      documents: [],
    })

    // Absent optional keys are omitted, not set to undefined.
    expect(detail.project.members).toStrictEqual([
      { sub: 's1', role: 'editor', username: 'ed', email: 'ed@example.com', added_by: 'sub-owner' },
      { sub: 's2', role: 'viewer', username: 'odd', email: '' },
    ])
  })

  it('leaves members undefined when the payload has none or sends a non-array', () => {
    const base = { personas: [], documents: [] }
    expect(normalizeProjectDetail({ ...base, project: { project_id: 'p1' } }).project.members).toBeUndefined()
    expect(normalizeProjectDetail({ ...base, project: { project_id: 'p1', members: { s1: {} } } }).project.members).toBeUndefined()
  })
})

describe('normalizeProject', () => {
  it('normalizes a create response project and rejects one without an id', () => {
    expect(normalizeProject({ project_id: 'p9', name: 'New', visibility: 'private' }))
      .toMatchObject({ project_id: 'p9', visibility: 'private', access: FAIL_CLOSED_ACCESS })
    expect(normalizeProject({ name: 'no id' })).toBeNull()
    expect(normalizeProject(undefined)).toBeNull()
  })
})

describe('normalizeProjectMembers', () => {
  it('keeps a well-formed response', () => {
    const result = normalizeProjectMembers({
      visibility: 'private',
      owner,
      members: [{ sub: 's1', role: 'viewer', username: 'v', email: 'v@example.com' }],
      access: managerAccess,
    })

    expect(result.visibility).toBe('private')
    expect(result.owner).toStrictEqual(owner)
    expect(result.members.map((m) => m.sub)).toStrictEqual(['s1'])
    expect(result.access).toStrictEqual(managerAccess)
  })

  it('reads an empty or garbage body as public, ownerless, memberless and unmanageable', () => {
    for (const raw of [{}, null, 'oops', { members: 'x', access: null, owner: 7 }]) {
      expect(normalizeProjectMembers(raw)).toStrictEqual({
        visibility: 'public', owner: null, members: [], access: FAIL_CLOSED_ACCESS,
      })
    }
  })
})

describe('normalizeProjectMember', () => {
  it('returns the member or null', () => {
    expect(normalizeProjectMember({ sub: 's1', role: 'editor' }))
      .toMatchObject({ sub: 's1', role: 'editor', username: '', email: '' })
    expect(normalizeProjectMember({ role: 'editor' })).toBeNull()
  })
})

describe('normalizeMemberCandidates', () => {
  it('keeps candidates with a sub and drops the rest', () => {
    expect(normalizeMemberCandidates({
      users: [
        { sub: 's1', username: 'alice', email: 'a@example.com', name: 'Alice' },
        { username: 'no-sub' },
        { sub: 's2' },
      ],
    })).toStrictEqual([
      { sub: 's1', username: 'alice', email: 'a@example.com', name: 'Alice' },
      { sub: 's2', username: '', email: '' },
    ])
  })

  it('returns [] for a body without a users array', () => {
    expect(normalizeMemberCandidates({})).toStrictEqual([])
    expect(normalizeMemberCandidates({ users: {} })).toStrictEqual([])
    expect(normalizeMemberCandidates(undefined)).toStrictEqual([])
  })
})
