/**
 * @fileoverview The library routes' answers read leniently (librarySchema.ts): a row without a usable item id is
 * dropped, a malformed field degrades to its default, a missing envelope reads as empty; an answer the page cannot
 * act on (a create without its upload) is an error.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeLibraryCreated, normalizeLibraryDetail, normalizeLibraryItemAnswer, normalizeLibraryPage,
  normalizeLibrarySuggestions, normalizeLibraryText,
} from './librarySchema'

const ID = 'lib_20261101090000_a1b2c3d4'
const OTHER = 'lib_20261102090000_b2c3d4e5'
const row = (extra: Record<string, unknown> = {}) => ({ item_id: ID, title: 'Q3 market report (Example Ltd)', slug: 'q3-market', status: 'ready', ...extra })

describe('normalizeLibraryPage', () => {
  it('keeps the well-formed rows and drops a row without a usable id', () => {
    const page = normalizeLibraryPage({ items: [row(), { item_id: 'not-an-id', title: 'x' }, { title: 'no id' }, 'junk'], total: 3, tags: ['q3'], next_cursor: '50' })
    expect(page.items.map((item) => item.item_id)).toStrictEqual([ID])
    expect([page.total, page.tags, page.nextCursor]).toStrictEqual([3, ['q3'], '50'])
  })

  it('degrades a malformed field to its default', () => {
    const [item] = normalizeLibraryPage({ items: [row({ tags: 'q3', status: 'exploded', bytes: '12', created_by: 7, pages: 'many' })] }).items
    expect(item).toMatchObject({ tags: [], status: 'failed', bytes: 0, created_by: undefined, pages: undefined, version: 1, native: false })
  })

  it('reads a missing or malformed envelope as an empty page', () => {
    const empty = { items: [], total: 0, tags: [], nextCursor: null }
    expect([normalizeLibraryPage(null), normalizeLibraryPage('nope'), normalizeLibraryPage({ total: 'x', tags: 5 })]).toStrictEqual([empty, empty, empty])
  })
})

describe('normalizeLibrarySuggestions', () => {
  it('keeps the suggestions with an id and a slug', () => {
    const items = normalizeLibrarySuggestions({ items: [{ item_id: ID, slug: 'q3-market', title: 'Q3' }, { item_id: OTHER, slug: '' }, { slug: 'x' }] })
    expect(items.map((item) => item.slug)).toStrictEqual(['q3-market'])
  })

  it('reads anything else as no suggestion', () => {
    expect([normalizeLibrarySuggestions(undefined), normalizeLibrarySuggestions({ items: 'x' })]).toStrictEqual([[], []])
  })
})

describe('the answers carrying one item', () => {
  it('reads a create with its upload, the signed headers kept as sent', () => {
    const created = normalizeLibraryCreated({ item: row({ status: 'pending' }), upload: { url: 'https://s3.example.com/put', headers: { 'Content-Type': 'text/csv', 'If-None-Match': '*' } } })
    expect([created.item.status, created.upload.headers, created.upload.expires_in]).toStrictEqual(['pending', { 'Content-Type': 'text/csv', 'If-None-Match': '*' }, 900])
  })

  it('refuses a create without an upload, and an answer without an item', () => {
    expect(() => normalizeLibraryCreated({ item: row() })).toThrow(/upload/)
    expect(() => normalizeLibraryItemAnswer({ item: { item_id: 'bad' } })).toThrow(/item_id/)
  })

  it('reads an item read with its preview, and without one', () => {
    const detail = normalizeLibraryDetail({ item: row(), preview: { text_excerpt: 'Summary', text_parts: 3, original_url: 'https://s3.example.com/get' } })
    expect([detail.excerpt, detail.textParts, detail.originalUrl]).toStrictEqual(['Summary', 3, 'https://s3.example.com/get'])
    expect(normalizeLibraryDetail({ item: row() })).toMatchObject({ excerpt: '', textParts: 0, originalUrl: null })
  })

  it('reads a page of text, its malformed fields as their defaults', () => {
    expect(normalizeLibraryText({ item_id: ID, page: 2, parts: 3, paged: true, text: 'Pricing' })).toStrictEqual({ item_id: ID, page: 2, parts: 3, paged: true, text: 'Pricing' })
    expect(normalizeLibraryText({ page: 'x', parts: null })).toStrictEqual({ page: 1, parts: 1, paged: false, text: '' })
  })
})
