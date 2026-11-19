/**
 * The skills library's answers as the Library reads them (7.56.00): an answer with no list where the list should be
 * is an error, never "no skills"; a bad skill or reference costs itself; a file is read strictly, with its text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { parseLibrary, parseLibraryFile } from './engineeringSkillLibraryApi'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { engineeringSkillLibraryApi } = await import('./engineeringSkillLibraryApi')

beforeEach(() => { resetFetchApi() })

describe('the skills library\'s answers', () => {
  it('refuse an answer with no list, and drop a bad skill and a bad reference', () => {
    expect(() => parseLibrary({})).toThrow('The skills library answer was unreadable')
    expect(() => parseLibrary({ skills: 'tdd' })).toThrow('The skills library answer was unreadable')
    const skills = parseLibrary({ skills: [{ name: 'tdd', roles: ['fixer'], references: [{ path: 'references/sources.md' }, { path: '' }] }, { description: 'no name' }] })
    expect(skills.map((skill) => [skill.name, skill.roles, skill.references.map((file) => file.path), skill.license]))
      .toStrictEqual([['tdd', ['fixer'], ['references/sources.md'], '']])
  })

  it('read a file only with its text, its reference null for the SKILL.md', () => {
    expect(() => parseLibraryFile({ name: 'tdd', path: 'skills/tdd/SKILL.md' })).toThrow('The skill file answer was unreadable')
    expect(parseLibraryFile({ name: 'tdd', path: 'skills/tdd/SKILL.md', text: '# TDD\n' }).reference).toBeNull()
  })

  it('ask for a reference by its path in the query, and for the SKILL.md without one', async () => {
    routeFetchApi({
      'GET /agents/engineering/skill-library/tdd': () => ({ name: 'tdd', reference: null, path: 'skills/tdd/SKILL.md', text: 'a' }),
      'GET /agents/engineering/skill-library/tdd?reference=references%2Fsources.md': () => ({
        name: 'tdd', reference: 'references/sources.md', path: 'skills/tdd/references/sources.md', text: 'b' }),
    }, { missStatus: 500 })
    expect((await engineeringSkillLibraryApi.file('tdd', null)).text).toBe('a')
    expect((await engineeringSkillLibraryApi.file('tdd', 'references/sources.md')).reference).toBe('references/sources.md')
    expect(fetchApi).toHaveBeenCalledTimes(2)
  })
})
