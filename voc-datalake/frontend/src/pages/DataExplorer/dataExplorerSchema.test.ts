/**
 * @fileoverview Pins the Data Explorer wire-boundary normalizers: the Lambda
 * shape passes through, legacy/mock shapes are mapped, and malformed entries
 * are dropped one at a time instead of blanking the view.
 */
import { describe, it, expect } from 'vitest'
import { normalizeBuckets, normalizeS3Listing } from './dataExplorerSchema'

describe('normalizeBuckets', () => {
  it('keeps the Lambda shape', () => {
    expect(normalizeBuckets({ buckets: [{ id: 'raw-data', name: 'voc-raw-123', label: 'VoC Raw Data' }] }))
      .toStrictEqual([{ id: 'raw-data', label: 'VoC Raw Data' }])
  })

  it('falls back to name for id and label (the shape that caused the React key warning)', () => {
    expect(normalizeBuckets({ buckets: [{ name: 'raw-data', region: 'us-west-2' }, { name: 'processed-data' }] }))
      .toStrictEqual([{ id: 'raw-data', label: 'raw-data' }, { id: 'processed-data', label: 'processed-data' }])
  })

  it('drops entries without an identity and de-duplicates ids', () => {
    expect(normalizeBuckets({ buckets: [{ region: 'x' }, 'junk', { id: 'a' }, { id: 'a', label: 'dup' }] }))
      .toStrictEqual([{ id: 'a', label: 'a' }])
  })

  it('returns an empty list for a non-list payload', () => {
    expect(normalizeBuckets(null)).toStrictEqual([])
    expect(normalizeBuckets({ buckets: 'nope' })).toStrictEqual([])
  })
})

describe('normalizeS3Listing', () => {
  it('returns undefined while there is no response', () => {
    expect(normalizeS3Listing(undefined)).toBeUndefined()
  })

  it('keeps the Lambda objects shape and drops malformed objects', () => {
    const listing = normalizeS3Listing({
      bucket: 'voc-raw',
      prefix: 'raw',
      objects: [
        { key: 'webscraper', size: 0, lastModified: '', isFolder: true },
        { key: 'a.json', fullKey: 'raw/a.json', size: 12, lastModified: '2026-01-01', isFolder: false },
        { size: 3 },
      ],
    })
    expect(listing?.bucket).toBe('voc-raw')
    expect(listing?.objects.map((o) => o.key)).toStrictEqual(['webscraper', 'a.json'])
    expect(listing?.objects[1]?.fullKey).toBe('raw/a.json')
  })

  it('maps the legacy { folders, files } shape', () => {
    const listing = normalizeS3Listing({
      bucket: 'raw-data',
      folders: ['webscraper/', 'manual_import/', 7],
      files: [{ key: 'webscraper/item1.json', size: 1234, last_modified: '2026-10-04T00:00:00Z' }, { nope: true }],
    })
    expect(listing?.objects).toStrictEqual([
      { key: 'webscraper', size: 0, lastModified: '', isFolder: true },
      { key: 'manual_import', size: 0, lastModified: '', isFolder: true },
      { key: 'item1.json', fullKey: 'webscraper/item1.json', size: 1234, lastModified: '2026-10-04T00:00:00Z', isFolder: false },
    ])
  })

  it('degrades to an empty listing for a non-object payload', () => {
    expect(normalizeS3Listing('boom')).toStrictEqual({ objects: [], bucket: '', prefix: '' })
  })
})
