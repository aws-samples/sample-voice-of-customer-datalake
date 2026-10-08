/**
 * Browser-side image preparation.
 *
 * jsdom has no image codec, so the imaging primitives are faked — but only the
 * primitives. What is under test is everything the module actually decides: which
 * rung of the degrade ladder is taken, the dimensions it targets, the content
 * type and filename it reports, and whether the size it declares matches the
 * blob it produces. The fake encoder models "how big would this come out" and the
 * assertions are about the module's response to that number.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { imageFile } from './imaging-fixtures'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE_PX,
  isImagePrepError,
  resizeImageForUpload,
} from './resizeImage'
import type { ImagePrepFailure } from './resizeImage'

/** Runs the resize on `file` and checks that it rejected with a typed `failure`. */
async function expectPrepFailure(file: File, failure: ImagePrepFailure) {
  const error = await resizeImageForUpload(file).catch((e: unknown) => e)

  expect(isImagePrepError(error)).toBe(true)
  if (!isImagePrepError(error)) throw new Error('expected an ImagePrepError')
  expect(error.failure).toBe(failure)
}

interface EncodeCall {
  readonly type: string
  readonly quality: number | undefined
  readonly width: number
  readonly height: number
  /** Fill colours applied before the draw — empty when nothing was filled. */
  readonly fills: readonly string[]
}

const encodeCalls: EncodeCall[] = []
const closedBitmaps: string[] = []

/**
 * Stand-in for a real encoder: PNG keeps roughly half a byte per pixel, JPEG
 * scales with quality. Overridden per test to force a particular rung.
 */
function realisticSize(call: EncodeCall): number {
  const pixels = call.width * call.height
  if (call.type === 'image/png') return Math.round(pixels * 0.5)
  return Math.round(pixels * (call.quality ?? 0.8) * 0.15)
}

// Mutable holder rather than a `let`, matching the repo's const-only style.
const config: {
  sizeFor: (call: EncodeCall) => number
  encodeRejects: boolean
} = { sizeFor: realisticSize, encodeRejects: false }

class FakeOffscreenCanvas {
  readonly width: number
  readonly height: number
  readonly fills: string[] = []

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(contextId: string) {
    if (contextId !== '2d') return null
    const ctx = {
      fillStyle: '',
      fillRect: () => { this.fills.push(ctx.fillStyle) },
      drawImage: () => undefined,
    }
    return ctx
  }

  convertToBlob(options: { type: string; quality?: number }): Promise<Blob> {
    const call: EncodeCall = {
      type: options.type,
      quality: options.quality,
      width: this.width,
      height: this.height,
      fills: [...this.fills],
    }
    encodeCalls.push(call)
    if (config.encodeRejects) return Promise.reject(new Error('codec unavailable'))
    return Promise.resolve(
      new Blob([new Uint8Array(config.sizeFor(call))], { type: options.type }),
    )
  }
}

function fakeBitmap(name: string, width: number, height: number) {
  return {
    width,
    height,
    close: () => { closedBitmaps.push(name) },
  }
}

function stubDecoder(width: number, height: number, name = 'bitmap') {
  const decode = vi.fn(() => Promise.resolve(fakeBitmap(name, width, height)))
  vi.stubGlobal('createImageBitmap', decode)
  return decode
}

describe('resizeImageForUpload', () => {
  beforeEach(() => {
    encodeCalls.length = 0
    closedBitmaps.length = 0
    config.sizeFor = realisticSize
    config.encodeRejects = false
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a smaller blob than the source for an image over both the pixel and byte limits', async () => {
    // 3000x2000 and 4 MB — over the long-edge ceiling AND over the byte cap, so
    // neither limit alone can be what makes this test pass.
    const source = imageFile('screenshot.png', 'image/png', 4_000_000)
    stubDecoder(3000, 2000)

    const result = await resizeImageForUpload(source)

    expect(result.sizeBytes).toBeLessThan(source.size)
    expect(result.sizeBytes).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(result).toMatchObject({ width: MAX_IMAGE_EDGE_PX, height: 1045, reencoded: true })
  })

  it('encodes PNG first so UI text stays free of compression artefacts', async () => {
    stubDecoder(3000, 2000)

    const result = await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000))

    expect(result).toMatchObject({ contentType: 'image/png', filename: 'shot.png' })
    // One encode, and no white fill on the PNG path: alpha survives.
    expect(encodeCalls.map((c) => ({ type: c.type, fills: c.fills }))).toStrictEqual([
      { type: 'image/png', fills: [] },
    ])
  })

  it('returns the original file unchanged when the image is already within both limits', async () => {
    const source = imageFile('small.png', 'image/png', 100_000)
    stubDecoder(800, 600)

    const result = await resizeImageForUpload(source)

    // Not upscaled to the 1568 ceiling, and not re-encoded at all — which is
    // also what keeps an animated GIF animated.
    expect(result).toMatchObject({ width: 800, height: 600, sizeBytes: 100_000, reencoded: false })
    expect(result.blob).toBe(source)
    expect(encodeCalls).toHaveLength(0)
  })

  it('does not upscale an image that is under the pixel ceiling but over the byte cap', async () => {
    stubDecoder(900, 600)

    const result = await resizeImageForUpload(imageFile('wide.png', 'image/png', 4_000_000))

    expect(result.reencoded).toBe(true)
    expect(result.width).toBe(900)
    expect(result.height).toBe(600)
  })

  it('passes a non-image file through untouched without decoding it', async () => {
    const decode = stubDecoder(10, 10)
    const source = new File(['# notes'], 'notes.md', { type: 'text/markdown' })

    const result = await resizeImageForUpload(source)

    expect(result.blob).toBe(source)
    expect(result).toMatchObject({
      contentType: 'text/markdown', filename: 'notes.md', sizeBytes: source.size, width: null,
    })
    expect(decode).not.toHaveBeenCalled()
  })

  it('falls back to JPEG, and changes the extension with it, when the PNG misses the cap', async () => {
    config.sizeFor = (call) => (call.type === 'image/png' ? 3_800_000 : 1_000_000)
    stubDecoder(3000, 2000)

    const result = await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000))

    // The extension has to follow the bytes: the S3 key is built from the
    // declared content type, so a .png name on JPEG bytes is a lie on the object.
    expect(result).toMatchObject({ contentType: 'image/jpeg', filename: 'shot.jpg', sizeBytes: 1_000_000 })
    // JPEG has no alpha, so the canvas must be filled white before the draw or
    // transparent pixels come out black.
    expect(encodeCalls.map((c) => ({ type: c.type, quality: c.quality, fills: c.fills }))).toStrictEqual([
      { type: 'image/png', quality: undefined, fills: [] },
      { type: 'image/jpeg', quality: 0.85, fills: ['#ffffff'] },
    ])
  })

  it('drops quality before resolution as it walks down the ladder', async () => {
    config.sizeFor = () => 3_800_000
    stubDecoder(3000, 2000)

    await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000)).catch(() => undefined)

    expect(encodeCalls.map((c) => [c.type, c.quality, c.width])).toStrictEqual([
      ['image/png', undefined, 1568],
      ['image/jpeg', 0.85, 1568],
      ['image/jpeg', 0.7, 1568],
      ['image/jpeg', 0.7, 1200],
      ['image/jpeg', 0.6, 1024],
    ])
  })

  it('throws a typed too-large error when even the lowest rung misses the cap', async () => {
    config.sizeFor = () => 3_800_000
    stubDecoder(3000, 2000)

    await expectPrepFailure(imageFile('huge.png', 'image/png', 9_000_000), 'too-large')
  })

  it('throws a typed unreadable error when the bytes cannot be decoded', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not an image'))))

    // Not a silent pass-through: an undecodable "image" must not be uploaded as
    // if it were fine.
    await expectPrepFailure(imageFile('broken.png', 'image/png', 4_000_000), 'unreadable')
  })

  it('throws a typed unreadable error when encoding fails', async () => {
    config.encodeRejects = true
    stubDecoder(3000, 2000)

    await expectPrepFailure(imageFile('shot.png', 'image/png', 4_000_000), 'unreadable')
  })

  it('releases the decoded bitmap on both the success and the failure path', async () => {
    stubDecoder(3000, 2000, 'ok')
    await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000))

    config.sizeFor = () => 3_800_000
    stubDecoder(3000, 2000, 'failed')
    await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000)).catch(() => undefined)

    expect(closedBitmaps).toStrictEqual(['ok', 'failed'])
  })

  it('encodes through a canvas element when OffscreenCanvas is unavailable', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined)
    stubDecoder(3000, 2000)
    const toBlob = vi.fn((callback: (blob: Blob | null) => void, type: string) => {
      callback(new Blob([new Uint8Array(1_000)], { type }))
    })
    const original = {
      getContext: HTMLCanvasElement.prototype.getContext,
      toBlob: HTMLCanvasElement.prototype.toBlob,
    }
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }),
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: toBlob,
    })

    try {
      const result = await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000))

      expect(result.sizeBytes).toBe(1_000)
      expect(result.width).toBe(MAX_IMAGE_EDGE_PX)
      expect(toBlob).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true, value: original.getContext,
      })
      Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
        configurable: true, value: original.toBlob,
      })
    }
  })

  it('decodes through an image element when createImageBitmap is unavailable', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fake', revokeObjectURL: revoke })
    vi.stubGlobal('Image', class {
      naturalWidth = 2000
      naturalHeight = 1000
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    })

    const result = await resizeImageForUpload(imageFile('shot.png', 'image/png', 4_000_000))

    expect(result.width).toBe(MAX_IMAGE_EDGE_PX)
    expect(result.height).toBe(784)
    // The object URL must be released, or every fallback decode leaks it.
    expect(revoke).toHaveBeenCalledWith('blob:fake')
  })
})
