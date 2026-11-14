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

  /** A canvas whose WebP encode answers PNG (a browser without WebP encoding); PNG bytes ≈ `perPixel` × pixels. */
  function pngOnlyCanvas(perPixel: number, drawn: number[] = []) {
    return class {
      readonly width: number
      readonly height: number
      constructor(width: number, height: number) { this.width = width; this.height = height; drawn.push(width) }
      getContext() { return { fillStyle: '', fillRect: () => {}, drawImage: () => {} } }
      convertToBlob(): Promise<Blob> {
        const blob = new Blob([new Uint8Array(8)], { type: 'image/png' })
        Object.defineProperty(blob, 'size', { value: Math.round(this.width * this.height * perPixel) })
        return Promise.resolve(blob)
      }
    }
  }

  // Regression (7.00.00 review): without WebP encoding the ladder had no smaller PNG, so such a logo was refused.
  it('without WebP encoding, falls back to a smaller PNG instead of refusing the logo', async () => {
    stubImaging(1024, 1024)
    // 1024 px PNG: 1.2 MB (over the target); 768 px: about 0.68 MB.
    const drawn: number[] = []
    vi.stubGlobal('OffscreenCanvas', pngOnlyCanvas(1.15, drawn))
    const small = await uploadableLogo(imageFile('logo.png', 'image/png', 2_000_000))
    expect([small.type, small.name]).toStrictEqual(['image/png', 'logo.png'])
    // PNG 1024 (too big), four WebP rungs (answered as PNG, skipped), then the PNG 768 rung wins.
    expect(drawn).toStrictEqual([1024, 1024, 1024, 768, 512, 768])
  })

  // Regression (commit review): a WebP rung answered with PNG bytes was once uploaded labelled image/webp.
  it('never labels PNG bytes as WebP, and refuses a logo no rung gets under 1 MB', async () => {
    stubImaging(1024, 1024)
    vi.stubGlobal('OffscreenCanvas', pngOnlyCanvas(5))
    expect(await failureOf(uploadableLogo(imageFile('logo.png', 'image/png', 2_000_000)))).toBe('too-large')
  })
})

describe('LOGO_IMAGE_POLICY', () => {
  it('keeps transparency on every rung: PNG, then WebP, then smaller PNGs, never JPEG', () => {
    const rungs = LOGO_IMAGE_POLICY.ladder.map((step) => `${step.type}@${step.maxEdge}`)
    expect(rungs).toStrictEqual([
      'image/png@1024', 'image/webp@1024', 'image/webp@1024', 'image/webp@768', 'image/webp@512',
      'image/png@768', 'image/png@512',
    ])
  })

  it('never goes over 1024 px or 1 MB', () => {
    expect(LOGO_IMAGE_POLICY.maxBytes).toBe(1_000_000)
    expect(Math.max(...LOGO_IMAGE_POLICY.ladder.map((step) => step.maxEdge))).toBe(LOGO_MAX_EDGE_PX)
  })
})
