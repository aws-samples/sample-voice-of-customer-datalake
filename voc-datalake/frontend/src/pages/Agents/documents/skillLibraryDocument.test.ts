/**
 * A library skill's file as a document (7.56.00): its SKILL.md with its front matter split off as Properties, a
 * reference file as written, read only (it changes with a release), named by its digest, read again by its path; a
 * file gone from the bundle (404) is none, and any other failure stays one (readOnly.ts `unlessGone`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { libraryDocumentOf, libraryFileAdapter } = await import('./skillLibraryDocument')
const { unlessGone } = await import('./readOnly')

const FILE = {
  name: 'tdd', reference: null, path: 'skills/tdd/SKILL.md', text: '---\nname: tdd\n---\n# Test first', digest: 'sha256:ab12', bytes: 31,
}
const SKILL_PATH = '/agents/engineering/skill-library/tdd'

beforeEach(() => { resetFetchApi() })

describe('a library skill\'s file', () => {
  it('splits a SKILL.md\'s front matter off, is never edited here and is named by its digest', () => {
    const adapter = libraryFileAdapter('tdd', null)
    expect(adapter).toMatchObject({ id: 'library:tdd:SKILL.md', contentType: 'markdown', frontMatter: 'split', permissions: { edit: 'managedByTemplate' } })
    expect(adapter.versionOf(libraryDocumentOf(FILE))).toStrictEqual({ token: 'sha256:ab12' })
  })

  it('reads a reference file as written, by its path in the skill', async () => {
    const reference = 'references/red-green.md'
    routeFetchApi({ [`GET ${SKILL_PATH}?reference=references%2Fred-green.md`]: () => ({ ...FILE, reference, path: reference, text: '# Red, green' }) })
    const adapter = libraryFileAdapter('tdd', reference)
    expect([adapter.id, 'frontMatter' in adapter]).toStrictEqual(['library:tdd:references/red-green.md', false])
    expect(await adapter.load(libraryDocumentOf(FILE))).toStrictEqual({ title: reference, content: '# Red, green', path: reference, digest: 'sha256:ab12' })
  })

  it('reads a file gone from the bundle as none', async () => {
    routeFetchApi({ [`GET ${SKILL_PATH}`]: () => { throw new ApiError(404, 'no such skill') } })
    expect(await libraryFileAdapter('tdd', null).load(libraryDocumentOf(FILE))).toBeUndefined()
    expect(fetchApi).toHaveBeenCalledWith(SKILL_PATH, undefined)
  })
})

describe('unlessGone', () => {
  it('keeps any failure but a 404 a failure', async () => {
    await expect(unlessGone(() => Promise.reject(new ApiError(500, 'The library is unreadable')))).rejects.toThrow('The library is unreadable')
  })
})
