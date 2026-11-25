/**
 * @fileoverview The library's routes as libraryApi.ts calls them (paths, methods, bodies; the answers normalised),
 * and the presigned PUT: exactly the headers the API signed, its progress, and a refusal as `LibraryUploadError`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi } from '@test/fetchApiRoutes'
import { fakeXhrPerTest } from '@test/fakeXhr'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { LibraryUploadError, libraryApi, libraryKeys, putLibraryFile } = await import('./libraryApi')

const ID = 'lib_20261101090000_a1b2c3d4'
const item = { item_id: ID, title: 'Q3 market report (Example Ltd)', slug: 'q3-market', status: 'ready', version: 2 }

const answer = (value: unknown) => fetchApi.mockResolvedValueOnce(value)
const call = (index = 0) => fetchApi.mock.calls[index] ?? []

beforeEach(() => {
  resetFetchApi()
})

describe('libraryApi', () => {
  it('lists with only the filters given', async () => {
    answer({ items: [item], total: 1, tags: [], next_cursor: null })
    answer({ items: [] })
    const page = await libraryApi.list({ q: 'q3 report', tag: 'market', projectId: 'p_1', sort: 'title', cursor: '50', limit: 10 })
    await libraryApi.list()
    expect(call(0)[0]).toBe('/projects/library?q=q3+report&tag=market&project_id=p_1&sort=title&cursor=50&limit=10')
    expect([call(1)[0], page.items.map((entry) => entry.slug)]).toStrictEqual(['/projects/library', ['q3-market']])
  })

  it('asks for suggestions with the typed text encoded', async () => {
    answer({ items: [{ item_id: ID, slug: 'q3-market' }] })
    const suggestions = await libraryApi.suggest('q3 & co')
    expect([call()[0], suggestions.map((entry) => entry.slug)]).toStrictEqual(['/projects/library/suggest?q=q3%20%26%20co', ['q3-market']])
  })

  it('creates an item with its body and reads its upload', async () => {
    answer({ item: { ...item, status: 'pending' }, upload: { url: 'https://s3.example.com/put', headers: { 'Content-Type': 'text/csv' } } })
    const created = await libraryApi.create({ filename: 'survey.csv', content_type: 'text/csv', bytes: 12 })
    expect([call()[0], call()[1]?.method, call()[1]?.body]).toStrictEqual(['/projects/library', 'POST', '{"filename":"survey.csv","content_type":"text/csv","bytes":12}'])
    expect(created.upload.url).toBe('https://s3.example.com/put')
  })

  it('marks an upload, retries, reads, pages the text and edits by the item\'s path', async () => {
    for (const value of [{ item }, { item }, { item, preview: { text_parts: 2 } }, { page: 2, parts: 2, text: 'p2' }, { item }]) answer(value)
    await libraryApi.markUploaded(ID)
    await libraryApi.retry(ID)
    const detail = await libraryApi.get(ID)
    const text = await libraryApi.text(ID, 2)
    await libraryApi.update(ID, { expected_version: 2, title: 'Q3' })
    expect(fetchApi.mock.calls.map(([path, options]) => `${options?.method ?? 'GET'} ${path}`)).toStrictEqual([
      `POST /projects/library/${ID}/uploaded`, `POST /projects/library/${ID}/retry`, `GET /projects/library/${ID}`,
      `GET /projects/library/${ID}/text?page=2`, `PUT /projects/library/${ID}`,
    ])
    expect([detail.textParts, text.text, call(4)[1]?.body]).toStrictEqual([2, 'p2', '{"expected_version":2,"title":"Q3"}'])
  })

  it('deletes by the item\'s path', async () => {
    answer({ success: true, deleted: ID })
    await expect(libraryApi.remove(ID)).resolves.toStrictEqual({ success: true, deleted: ID })
    expect([call()[0], call()[1]?.method]).toStrictEqual([`/projects/library/${ID}`, 'DELETE'])
  })

  it('keys the list, an item, its text and the suggestions under one root', () => {
    expect([libraryKeys.list({ q: 'x' }), libraryKeys.item(ID), libraryKeys.text(ID, 3), libraryKeys.suggest('q')]).toStrictEqual([
      ['library', 'list', { q: 'x' }], ['library', 'item', ID], ['library', 'text', ID, 3], ['library', 'suggest', 'q'],
    ])
  })
})

describe('putLibraryFile', () => {
  const xhr = fakeXhrPerTest()
  const upload = { url: 'https://s3.example.com/put?sig=1', headers: { 'Content-Type': 'text/csv', 'If-None-Match': '*' }, expires_in: 900 }
  const file = new Blob(['a,b\n1,2\n'], { type: 'application/vnd.ms-excel' })

  it('PUTs the file with exactly the signed headers and reports its progress', async () => {
    const progress: number[] = []
    const done = putLibraryFile(upload, file, (fraction) => progress.push(fraction))
    const request = xhr.last()
    request.progress(4, 8)
    request.progress(1, 0, false)
    request.respond(200)
    await done
    expect([request.method, request.url, request.headers, request.body]).toStrictEqual(['PUT', upload.url, upload.headers, file])
    expect(progress).toStrictEqual([0.5])
  })

  it('needs no progress listener', async () => {
    const done = putLibraryFile(upload, file)
    xhr.last().progress(8, 8)
    xhr.last().respond(204)
    await expect(done).resolves.toBeUndefined()
  })

  it('rejects a refused PUT with its status, and a network failure with 0', async () => {
    const refused = putLibraryFile(upload, file)
    xhr.last().respond(403)
    await expect(refused).rejects.toBeInstanceOf(LibraryUploadError)
    await expect(refused).rejects.toMatchObject({ status: 403, message: 'The upload failed (403)' })
    const dropped = putLibraryFile(upload, file)
    xhr.last().fail()
    await expect(dropped).rejects.toMatchObject({ name: 'LibraryUploadError', status: 0 })
  })
})
