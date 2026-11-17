/** The Skills view's rules: the address's options, a status's badge, the versions a person types, a diff's side changes. */
import { describe, it, expect } from 'vitest'
import { parseVersionsInput, sideChangesEmpty, skillsViewOf, statusTone } from './skillsView'

const view = (query: string, role: string | null = null, version: number | null = null) =>
  skillsViewOf({ role, version }, new URLSearchParams(query))
const MOVED: [string, string] = ['model-a', 'model-b']
const NO_CHANGE = { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: false }

describe('the Skills view', () => {
  it('reads the role and the version from the path, and the scope from the query', () => {
    expect(view('connection=storefront', 'fixer', 3)).toStrictEqual({ connection: 'storefront', role: 'fixer', version: 3 })
    expect(view('')).toStrictEqual({ connection: '', role: null, version: null })
  })

  it('leaves out a role off the catalog, and its version with it', () => {
    expect(view('', 'wizard', 3)).toStrictEqual({ connection: '', role: null, version: null })
    expect(view('role=fixer&version=3')).toStrictEqual({ connection: '', role: null, version: null })
  })

  it('gives each status its badge, an unknown one muted', () => {
    expect(['accepted', 'proposed', 'rejected', 'other'].map(statusTone)).toStrictEqual(
      ['badge badge-ok', 'badge badge-warn', 'badge badge-danger', 'badge badge-muted'])
  })

  it('reads the versions to compare: whole numbers, at most ten, each once', () => {
    expect(parseVersionsInput(' 3, 2 1 ')).toStrictEqual({ ok: true, versions: [3, 2, 1] })
    expect(['', '2, x', '0', '1,2,3,4,5,6,7,8,9,10,11', '2,2'].map((typed) => parseVersionsInput(typed))).toStrictEqual([
      { ok: false, reason: 'empty' }, { ok: false, reason: 'notNumbers' }, { ok: false, reason: 'notNumbers' },
      { ok: false, reason: 'tooMany' }, { ok: false, reason: 'repeated' }])
  })

  it('tells a diff that changes nothing beside its instructions from one that changes a part', () => {
    expect(sideChangesEmpty({ ...NO_CHANGE, instructions: [['+', 'Run the tests.']] })).toBe(true)
    expect([{ tools_reordered: true }, { model: MOVED }, { tools_removed: ['run'] }]
      .map((part) => sideChangesEmpty({ ...NO_CHANGE, ...part }))).toStrictEqual([false, false, false])
  })
})
