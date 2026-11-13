/**
 * @fileoverview logoImage: a logo over 1 MB is made smaller (PNG first, then WebP, never JPEG) instead of
 * refused; one within 1 MB is uploaded as it is without being decoded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageFile, stubImaging, stubOversizedImaging, stubUnreadableImage } from '../ProjectDetail/imaging-fixtures'
import { isImagePrepError } from '../ProjectDetail/resizeImage'
import { LOGO_IMAGE_POLICY, LOGO_MAX_BYTES, LOGO_MAX_EDGE_PX, uploadableLogo } from './logoImage'

afterEach(() => { vi.unstubAllGlobals() })

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return isImagePrepError(error) ? error.failure : 'other'
  }
}

describe('uploadableLogo', () => {
  it('keeps a logo within 1 MB as it is, without decoding it', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const file = imageFile('logo.png', 'image/png', LOGO_MAX_BYTES)
    expect(await uploadableLogo(file)).toBe(file)
    expect(decode).not.toHaveBeenCalled()
  })

  it('shrinks a 3 MB logo to a PNG at most 1024 px on its longest side', async () => {
    stubImaging(4000, 2000)
    const small = await uploadableLogo(imageFile('logo.jpg', 'image/jpeg', 3_000_000))
    expect([small.type, small.name]).toStrictEqual(['image/png', 'logo.png'])
    // The fake encoder answers half a byte per pixel: 1024 × 512 / 2.
    expect(small.size).toBe(262_144)
  })

  it('a logo still over 1 MB on every rung is a too-large error, not an upload', async () => {
    stubOversizedImaging()
    expect(await failureOf(uploadableLogo(imageFile('huge.png', 'image/png', 4_000_000)))).toBe('too-large')
  })

  it('a file that cannot be decoded is an unreadable error', async () => {
    stubUnreadableImage()
    expect(await failureOf(uploadableLogo(imageFile('broken.png', 'image/png', 2_000_000)))).toBe('unreadable')
  })
})

describe('LOGO_IMAGE_POLICY', () => {
  it('keeps transparency on every rung: PNG first, then WebP, never JPEG', () => {
    const types = LOGO_IMAGE_POLICY.ladder.map((step) => step.type)
    expect(types[0]).toBe('image/png')
    expect(types).not.toContain('image/jpeg')
    expect(new Set(types.slice(1))).toStrictEqual(new Set(['image/webp']))
  })

  it('never goes over 1024 px or 1 MB', () => {
    expect(LOGO_IMAGE_POLICY.maxBytes).toBe(1_000_000)
    expect(Math.max(...LOGO_IMAGE_POLICY.ladder.map((step) => step.maxEdge))).toBe(LOGO_MAX_EDGE_PX)
  })
})
