/**
 * The Data Explorer's S3 actions: open a file in the editor from its preview, open a new file under the
 * current folder (`raw/` at the root), and download a file (inline content as a Blob, a presigned URL fetched).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api } from '../../api/client'
import type { EditModalState } from './EditModal'
import { downloadS3File, openS3Creator, openS3Editor } from './s3Handlers'

/** A preview as `GET /data-explorer/s3/preview` answers it. */
function previewOf(content: unknown, extra: { contentType?: string; isPresignedUrl?: boolean } = {}) {
  return { content, size: 10, contentType: 'application/json', key: 'raw/x/1.json', isPresignedUrl: false, ...extra }
}

describe('openS3Editor', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('opens the editor on the preview of the file in the selected bucket', async () => {
    const preview = vi.spyOn(api, 'getDataExplorerS3Preview').mockResolvedValue(previewOf({ a: 1 }))
    const setEditModal = vi.fn()

    await openS3Editor('raw/x/1.json', 'edit', 'raw-data', setEditModal)

    expect(preview).toHaveBeenCalledWith('raw/x/1.json', 'raw-data')
    expect(setEditModal).toHaveBeenCalledWith({
      isOpen: true, mode: 'edit', type: 's3', data: { a: 1 }, key: 'raw/x/1.json',
      contentType: 'application/json', isPresignedUrl: false,
    })
  })
})

describe('openS3Creator', () => {
  it.each([
    [[], 'raw/'],
    [['raw', 'webscraper'], 'raw/webscraper/'],
  ])('creates a new JSON file under %j (key prefix %s)', (path, prefix) => {
    const setEditModal = vi.fn<(state: EditModalState) => void>()

    openS3Creator(path, setEditModal)

    const state = setEditModal.mock.calls[0]?.[0]
    expect(state).toMatchObject({ isOpen: true, mode: 'create', type: 's3' })
    expect(state?.key).toMatch(new RegExp(`^${prefix}\\d+\\.json$`))
  })
})

describe('downloadS3File', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:download')
  const revokeObjectURL = vi.fn()
  // jsdom has no object URLs: install fakes for this block and put back whatever was there.
  const NAMES = ['createObjectURL', 'revokeObjectURL'] as const
  const original = NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(URL, name)] as const)

  beforeEach(() => {
    vi.restoreAllMocks()
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(URL, name, descriptor)
      else Reflect.deleteProperty(URL, name)
    }
    vi.unstubAllGlobals()
  })

  it('downloads inline JSON content as a JSON Blob and frees the URL', async () => {
    vi.spyOn(api, 'getDataExplorerS3Preview').mockResolvedValue(previewOf({ a: 1 }))

    await downloadS3File('raw/x/1.json', '1.json', 'raw-data')

    const blob = createObjectURL.mock.calls[0]?.[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(blob?.type).toBe('application/json')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download')
  })

  it('fetches a presigned URL and downloads what it returns', async () => {
    vi.spyOn(api, 'getDataExplorerS3Preview').mockResolvedValue(previewOf('https://bucket.example/a.png', { contentType: 'image/png', isPresignedUrl: true }))
    const fetched = new Blob(['png'], { type: 'image/png' })
    const fetchMock = vi.fn(() => Promise.resolve({ blob: () => Promise.resolve(fetched) }))
    vi.stubGlobal('fetch', fetchMock)

    await downloadS3File('raw/x/a.png', 'a.png', 'raw-data')

    expect(fetchMock).toHaveBeenCalledWith('https://bucket.example/a.png')
    expect(createObjectURL).toHaveBeenCalledWith(fetched)
  })
})
