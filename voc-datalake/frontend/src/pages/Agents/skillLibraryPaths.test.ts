/**
 * Agents → Skills → Library's addresses (7.56.00): the library, a skill and one of its references are paths, read back
 * as they were written, and agentsPaths.ts leaves every place under `library` as it is (never a role's history).
 */
import { describe, it, expect } from 'vitest'
import { readAgentsAddress } from './agentsPaths'
import { libraryPath, readLibraryPlace } from './skillLibraryPaths'

describe('the Library\'s paths', () => {
  it('write the library, a skill and a reference, and read each back', () => {
    const places = [{}, { skill: 'tdd' }, { skill: 'tdd', reference: 'references/sources.md' }]
    expect(places.map((place) => libraryPath(place))).toStrictEqual(
      ['/agents/skills/library', '/agents/skills/library/tdd', '/agents/skills/library/tdd/references/sources.md'])
    expect(places.map((place) => readLibraryPlace(libraryPath(place)))).toStrictEqual([
      { skill: null, reference: null }, { skill: 'tdd', reference: null }, { skill: 'tdd', reference: 'references/sources.md' }])
  })

  it('read a path that is not a reference as its skill, and a path outside the library as none', () => {
    expect(readLibraryPlace('/agents/skills/library/tdd/notes/x.md')).toStrictEqual({ skill: 'tdd', reference: null })
    expect(readLibraryPlace('/agents/skills/library/tdd/references/a/b.md')).toStrictEqual({ skill: 'tdd', reference: null })
    expect([readLibraryPlace('/agents/skills/fixer'), readLibraryPlace('/agents/skills/libraryx')]).toStrictEqual([null, null])
  })

  it('are the Skills tab\'s own places: never replaced, never read as a role', () => {
    const read = readAgentsAddress({ pathname: '/agents/skills/library/tdd/references/sources.md', search: '' })
    expect(read).toStrictEqual({ place: { view: 'skills', role: 'library', version: null }, replaceWith: null })
  })
})
