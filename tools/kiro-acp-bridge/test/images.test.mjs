import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  IMAGE_LIMITS,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_RAW_BYTES,
  MAX_LOSSLESS_RAW_BYTES,
  imageDimensions,
  validateImage,
} from '../src/images.mjs'
import { b64, gif, jpeg, png, webpVp8, webpVp8l, webpVp8x } from './fixtures/images.mjs'

describe('imageDimensions', () => {
  const cases = [
    ['image/png', png(1234, 567)],
    ['image/gif', gif(1234, 567)],
    ['image/jpeg', jpeg(1234, 567)],
    ['image/jpeg', jpeg(1234, 567, 0xc2)], // progressive
    ['image/webp', webpVp8x(1234, 567)],
    ['image/webp', webpVp8l(1234, 567)],
    ['image/webp', webpVp8(1234, 567)],
  ]
  for (const [mimeType, bytes] of cases) {
    it(`reads 1234x567 from ${mimeType} (${bytes.subarray(12, 16).toString('latin1').trim() || bytes[3]})`, () => {
      assert.deepEqual(imageDimensions(mimeType, bytes), { width: 1234, height: 567 })
    })
  }

  it('returns null when the bytes are not the declared format', () => {
    assert.equal(imageDimensions('image/jpeg', png(10, 10)), null)
    assert.equal(imageDimensions('image/png', jpeg(10, 10)), null)
    assert.equal(imageDimensions('image/webp', Buffer.alloc(40)), null)
  })

  it('returns null for a JPEG that reaches start-of-scan without a frame header', () => {
    assert.equal(imageDimensions('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00])), null)
  })

  it('returns null for truncated headers instead of throwing', () => {
    for (const [type, bytes] of [['image/png', png(10, 10).subarray(0, 20)], ['image/jpeg', jpeg(10, 10).subarray(0, 25)], ['image/gif', gif(10, 10).subarray(0, 8)]]) {
      assert.equal(imageDimensions(type, bytes), null)
    }
  })
})

describe('validateImage', () => {
  it('accepts an image inside every limit and reports its size', () => {
    assert.deepEqual(validateImage({ mimeType: 'image/png', data: b64(png(2000, 2000)) }), {
      ok: true,
      width: 2000,
      height: 2000,
      rawBytes: 64,
    })
  })

  it('pins the limits to the model endpoint: 5 MiB base64 = 3.75 MiB raw, 2000 px', () => {
    assert.equal(MAX_IMAGE_BASE64_BYTES, 5_242_880)
    assert.equal(MAX_IMAGE_RAW_BYTES, 3_932_160)
    assert.equal(IMAGE_LIMITS.maxDimension, 2000)
  })

  it('accepts a JPEG exactly at the raw ceiling (its base64 is exactly 5 MiB)', () => {
    const data = b64(jpeg(100, 100, 0xc0, MAX_IMAGE_RAW_BYTES))
    assert.equal(data.length, MAX_IMAGE_BASE64_BYTES)
    assert.equal(validateImage({ mimeType: 'image/jpeg', data }).ok, true)
  })

  it('caps non-JPEG formats at 2.5 MiB raw, because Kiro re-encodes them larger', () => {
    assert.equal(MAX_LOSSLESS_RAW_BYTES, 2_621_440)
    assert.equal(validateImage({ mimeType: 'image/png', data: b64(png(100, 100, MAX_LOSSLESS_RAW_BYTES)) }).ok, true)
    const verdict = validateImage({ mimeType: 'image/png', data: b64(png(100, 100, MAX_LOSSLESS_RAW_BYTES + 1)) })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /at most 2\.5 MiB because Kiro re-encodes/)
    assert.equal(validateImage({ mimeType: 'image/jpeg', data: b64(jpeg(100, 100, 0xc0, 3_000_000)) }).ok, true)
  })

  it('publishes per-type raw ceilings for the page', () => {
    assert.deepEqual(IMAGE_LIMITS.maxRawBytesByType, {
      'image/png': MAX_LOSSLESS_RAW_BYTES,
      'image/jpeg': MAX_IMAGE_RAW_BYTES,
      'image/gif': MAX_LOSSLESS_RAW_BYTES,
      'image/webp': MAX_LOSSLESS_RAW_BYTES,
    })
  })

  it('refuses a 4 MB raw image, because its base64 is over 5 MiB (kirodotdev/Kiro#11497)', () => {
    const verdict = validateImage({ mimeType: 'image/png', data: b64(png(100, 100, 4_000_000)) })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /5 MiB base64 \(3\.75 MiB raw\)/)
  })

  for (const [width, height] of [[2001, 10], [10, 2001], [4000, 3000]]) {
    it(`refuses ${width}x${height} (over the 2000 px many-image cap)`, () => {
      const verdict = validateImage({ mimeType: 'image/jpeg', data: b64(jpeg(width, height)) })
      assert.equal(verdict.ok, false)
      assert.match(verdict.reason, /at most 2000px/)
    })
  }

  it('refuses zero-pixel images', () => {
    assert.equal(validateImage({ mimeType: 'image/png', data: b64(png(0, 10)) }).ok, false)
  })

  it('refuses a mime type that does not match the bytes', () => {
    const verdict = validateImage({ mimeType: 'image/jpeg', data: b64(png(10, 10)) })
    assert.match(verdict.reason, /not a valid image\/jpeg/)
  })

  for (const mimeType of ['image/svg+xml', 'image/bmp', 'text/html', '']) {
    it(`refuses ${mimeType || 'an empty'} mime type`, () => {
      assert.match(validateImage({ mimeType, data: b64(png(10, 10)) }).reason, /not supported/)
    })
  }

  for (const data of ['', 'abc', 'ab$d', 'YWJj\nZA==', 'data:image/png;base64,AAAA']) {
    it(`refuses malformed base64 ${JSON.stringify(data)}`, () => {
      assert.equal(validateImage({ mimeType: 'image/png', data }).ok, false)
    })
  }
})
