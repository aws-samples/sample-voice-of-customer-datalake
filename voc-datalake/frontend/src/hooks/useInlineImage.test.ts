/**
 * fetchInlineImage: presigned S3 logos become data: URLs, because the app's CSP allows images only
 * from 'self' and data: (prod 5.21: the company logo and reference logo previews were blocked).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchInlineImage } from './useInlineImage'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const PRESIGNED = 'https://voc-raw.s3.us-west-2.amazonaws.com/company-context/design/logo.png?X-Amz-Signature=abc'
// The 5 MB cap in useInlineImage.ts (MAX_IMAGE_BYTES).
const MAX_BYTES = 5 * 1024 * 1024

function answer(body: BodyInit, type: string, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, { status, headers: { 'Content-Type': type } }))))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchInlineImage', () => {
  it('turns a presigned raster image into a data: URL the CSP allows', async () => {
    answer(PNG, 'image/png')
    const src = await fetchInlineImage(PRESIGNED)
    // The PNG signature's exact base64: the bytes survive, not just the prefix.
    expect(src).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  // Regression (CI, Node 22): FileReader refused the fetch answer's Blob ("parameter 1 is not of
  // type 'Blob'"); the bytes are now encoded directly, in chunks so a big logo cannot overflow the stack.
  it('encodes an image larger than one chunk byte for byte', async () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 256)
    answer(bytes, 'image/jpeg')
    const src = await fetchInlineImage(PRESIGNED)
    const decoded = Uint8Array.from(atob((src ?? '').replace('data:image/jpeg;base64,', '')), (char) => char.charCodeAt(0))
    expect(decoded).toStrictEqual(bytes)
  })

  it('names the type without its parameters', async () => {
    answer(PNG, 'image/png; charset=binary')
    expect(await fetchInlineImage(PRESIGNED)).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('leaves same-origin paths and data: URLs as they are, without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await fetchInlineImage('/design/logo.png')).toBe('/design/logo.png')
    expect(await fetchInlineImage('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses non-https, protocol-relative and non-raster answers (SVG can carry script)', async () => {
    expect(await fetchInlineImage('http://example.com/logo.png')).toBeNull()
    expect(await fetchInlineImage('//example.com/logo.png')).toBeNull()
    answer('<svg onload="x()"/>', 'image/svg+xml')
    expect(await fetchInlineImage(PRESIGNED)).toBeNull()
  })

  it('returns null for an expired or missing object', async () => {
    answer('denied', 'application/xml', 403)
    expect(await fetchInlineImage(PRESIGNED)).toBeNull()
  })

  it.each([
    ['an empty body', new Uint8Array(0), 'image/png'],
    ['an image over 5 MB', new Uint8Array(MAX_BYTES + 1), 'image/png'],
    ['an answer without a Content-Type', PNG, ''],
  ])('returns null for %s', async (_case, body, type) => {
    answer(body, type)
    expect(await fetchInlineImage(PRESIGNED)).toBeNull()
  })

  it('accepts an image of exactly 5 MB', async () => {
    answer(new Uint8Array(MAX_BYTES), 'image/gif')
    expect(await fetchInlineImage(PRESIGNED)).toMatch(/^data:image\/gif;base64,AAAA/)
  })
})
