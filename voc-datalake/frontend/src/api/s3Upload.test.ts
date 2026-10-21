import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetS3UploadUrl = vi.fn()
vi.mock('./client', () => ({
  api: { getS3UploadUrl: (f: string, s: string, c?: string, sf?: string) => mockGetS3UploadUrl(f, s, c, sf) },
}))

import {
  uploadFileToS3,
  SUPPORTED_IMPORT_FILE_REGEX,
  SYNC_JSON_UPLOAD_MAX_BYTES,
} from './s3Upload'

function makeFile(name: string, type = 'application/json'): File {
  return new File(['x'], name, { type })
}

describe('SUPPORTED_IMPORT_FILE_REGEX', () => {
  it('accepts csv, json and jsonl case-insensitively', () => {
    for (const n of ['a.csv', 'a.JSON', 'a.jsonl', 'A.JSONL']) {
      expect(SUPPORTED_IMPORT_FILE_REGEX.test(n)).toBe(true)
    }
  })

  it('rejects other extensions', () => {
    for (const n of ['a.txt', 'a.xlsx', 'a.json.exe', 'noext']) {
      expect(SUPPORTED_IMPORT_FILE_REGEX.test(n)).toBe(false)
    }
  })
})

describe('SYNC_JSON_UPLOAD_MAX_BYTES', () => {
  it('is the API Gateway 10 MB request-body ceiling', () => {
    expect(SYNC_JSON_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024)
  })
})

describe('uploadFileToS3', () => {
  beforeEach(() => {
    mockGetS3UploadUrl.mockReset()
    vi.restoreAllMocks()
  })

  it('rejects an unsupported file type before any network call', async () => {
    const result = await uploadFileToS3(makeFile('data.txt', 'text/plain'), 'trustpilot')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unsupported file type')
    expect(mockGetS3UploadUrl).not.toHaveBeenCalled()
  })

  it('PUTs the file to the presigned URL and reports success', async () => {
    mockGetS3UploadUrl.mockResolvedValue({ success: true, upload_url: 'https://s3.example/put', key: 'trustpilot/data.json' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    const file = makeFile('data.json')
    const result = await uploadFileToS3(file, 'trustpilot')

    expect(result.ok).toBe(true)
    expect(mockGetS3UploadUrl).toHaveBeenCalledWith('data.json', 'trustpilot', 'application/json', undefined)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s3.example/put',
      expect.objectContaining({ method: 'PUT', body: file }),
    )
  })

  it('reports the API error when the presigned URL cannot be obtained', async () => {
    mockGetS3UploadUrl.mockResolvedValue({ success: false, error: 'bucket not configured' })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const result = await uploadFileToS3(makeFile('data.json'), 'trustpilot')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('bucket not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a non-ok S3 PUT as a failure', async () => {
    mockGetS3UploadUrl.mockResolvedValue({ success: true, upload_url: 'https://s3.example/put' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))

    const result = await uploadFileToS3(makeFile('data.json'), 'trustpilot')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('403')
  })

  it('catches a thrown network error instead of propagating it', async () => {
    mockGetS3UploadUrl.mockResolvedValue({ success: true, upload_url: 'https://s3.example/put' })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))

    const result = await uploadFileToS3(makeFile('data.json'), 'trustpilot')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('network down')
  })

  it('defaults the content type when the file has none', async () => {
    mockGetS3UploadUrl.mockResolvedValue({ success: true, upload_url: 'https://s3.example/put' })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    await uploadFileToS3(makeFile('data.json', ''), 'trustpilot')

    expect(mockGetS3UploadUrl).toHaveBeenCalledWith('data.json', 'trustpilot', 'application/octet-stream', undefined)
  })

  it('passes the sourceField when signing and echoes it as the PUT metadata header', async () => {
    mockGetS3UploadUrl.mockResolvedValue({
      success: true, upload_url: 'https://s3.example/put', source_field: 'platform',
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    const result = await uploadFileToS3(makeFile('data.json'), 'trustpilot', 'platform')

    expect(result.ok).toBe(true)
    expect(mockGetS3UploadUrl).toHaveBeenCalledWith('data.json', 'trustpilot', 'application/json', 'platform')
    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string, string>)['x-amz-meta-source-field']).toBe('platform')
  })

  it('sends no metadata header when the URL was not signed with a source field', async () => {
    mockGetS3UploadUrl.mockResolvedValue({ success: true, upload_url: 'https://s3.example/put', source_field: null })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))

    await uploadFileToS3(makeFile('data.json'), 'trustpilot')

    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string, string>)['x-amz-meta-source-field']).toBeUndefined()
  })
})
