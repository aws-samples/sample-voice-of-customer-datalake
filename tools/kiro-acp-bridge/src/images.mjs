/**
 * Image prompt-block policy.
 *
 * An image that Kiro accepts into a session but the model endpoint later
 * refuses is stored in the history and replayed every turn, so the whole
 * session is wedged from then on. The bridge therefore refuses anything the
 * endpoint would refuse, before it reaches Kiro:
 *
 *   - 5 MiB of base64 per image (= 3.75 MiB raw). The endpoint measures the
 *     ENCODED payload, so a "4 MB" raw image is already over the line.
 *     kirodotdev/Kiro#11497 (also #10783, #9707).
 *   - 2.5 MiB raw for every format except JPEG. Measured against kiro-cli
 *     2.27.1: Kiro decodes and RE-ENCODES prompt images before sending them,
 *     so the endpoint judges Kiro's output, not ours. Padding inside a file is
 *     stripped (a 5.09 MiB-base64 JPEG and a 5.01 MiB-base64 PNG were both
 *     accepted), JPEG re-encodes never grew (2000x2000 noise at quality 1.0,
 *     3.67 MiB raw, passed), but a 3.73 MiB PNG came out as 6,069,576 base64
 *     bytes (+16.5%) and was dropped. The model then answered as if no image
 *     had been attached, with no error to the client. 2.5 MiB leaves 1.5x
 *     headroom for that inflation; larger lossless images become JPEG.
 *   - 2000 px on each side. The endpoint applies this to every image once a
 *     request carries more than 20 images. Kiro Web #8884, CLI #11663, #11780.
 *   - a per-session image budget well under the 100-image wall that wedges
 *     v3 sessions (#11664); Kiro's own read tool adds images the bridge cannot see.
 *
 * Dimensions are read from the file header, not trusted from the page.
 */

/** Endpoint ceiling on one image's base64 payload (kirodotdev/Kiro#11497). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024
/** Equivalent raw ceiling: base64 inflates by 4/3. */
export const MAX_IMAGE_RAW_BYTES = (MAX_IMAGE_BASE64_BYTES / 4) * 3
/** Raw ceiling for formats Kiro may re-encode larger (everything but JPEG); see the header comment. */
export const MAX_LOSSLESS_RAW_BYTES = 2.5 * 1024 * 1024
/** Longest side the many-image endpoint accepts. */
export const MAX_IMAGE_DIMENSION = 2000
export const MAX_IMAGES_PER_PROMPT = 4
export const MAX_IMAGES_PER_SESSION = 20
/** Formats the model endpoint accepts. SVG is deliberately absent (script-capable, not a raster). */
export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

const ascii = (buf, start, end) => buf.toString('latin1', start, end)

function pngSize(buf) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buf.length < 24 || !signature.every((b, i) => buf[i] === b) || ascii(buf, 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gifSize(buf) {
  const magic = ascii(buf, 0, 6)
  if (buf.length < 10 || (magic !== 'GIF87a' && magic !== 'GIF89a')) return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/** Start-of-frame markers carry the frame size; DHT (C4), JPG (C8) and DAC (CC) do not. */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function isStandaloneJpegMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null
    const marker = buf[offset + 1]
    if (marker === 0xff) {
      offset += 1 // fill byte
    } else if (isStandaloneJpegMarker(marker)) {
      offset += 2
    } else if (marker === 0xd9 || marker === 0xda) {
      return null // end of image / start of scan before any frame header
    } else {
      const length = buf.readUInt16BE(offset + 2)
      if (length < 2) return null
      if (JPEG_SOF_MARKERS.has(marker)) {
        if (offset + 9 > buf.length) return null
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return null
}

function webpSize(buf) {
  if (buf.length < 30 || ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 12) !== 'WEBP') return null
  const chunk = ascii(buf, 12, 16)
  if (chunk === 'VP8X') {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null
    const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]]
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    }
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  return null
}

const SIZE_READERS = {
  'image/png': pngSize,
  'image/gif': gifSize,
  'image/jpeg': jpegSize,
  'image/webp': webpSize,
}

/** Reads pixel dimensions from the header of the declared format, or null if the bytes are not that format. */
export function imageDimensions(mimeType, buf) {
  const reader = SIZE_READERS[mimeType]
  return reader ? reader(buf) : null
}

/**
 * Validates one ACP image block's `mimeType` + base64 `data`.
 * @returns {{ok: true, width: number, height: number, rawBytes: number} | {ok: false, reason: string}}
 */
export function validateImage({ mimeType, data }) {
  if (!IMAGE_MIME_TYPES.includes(mimeType)) {
    return { ok: false, reason: `image type ${mimeType} is not supported (${IMAGE_MIME_TYPES.join(', ')})` }
  }
  if (data.length > MAX_IMAGE_BASE64_BYTES) {
    const mib = (data.length / 1024 / 1024).toFixed(2)
    return { ok: false, reason: `image is ${mib} MiB base64; the model limit is 5 MiB base64 (3.75 MiB raw)` }
  }
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    return { ok: false, reason: 'image data is not valid base64' }
  }
  const buf = Buffer.from(data, 'base64')
  const size = imageDimensions(mimeType, buf)
  if (!size) return { ok: false, reason: `image bytes are not a valid ${mimeType} file` }
  if (buf.length > maxRawBytesFor(mimeType)) {
    const mib = (buf.length / 1024 / 1024).toFixed(2)
    return {
      ok: false,
      reason: `${mimeType} is ${mib} MiB; non-JPEG images must be at most 2.5 MiB because Kiro re-encodes them larger (send it as JPEG)`,
    }
  }
  if (size.width < 1 || size.height < 1) return { ok: false, reason: 'image has no pixels' }
  if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: `image is ${size.width}x${size.height}px; each side must be at most ${MAX_IMAGE_DIMENSION}px`,
    }
  }
  return { ok: true, width: size.width, height: size.height, rawBytes: buf.length }
}

/** Raw-byte ceiling for one image of `mimeType`. */
export function maxRawBytesFor(mimeType) {
  return mimeType === 'image/jpeg' ? MAX_IMAGE_RAW_BYTES : MAX_LOSSLESS_RAW_BYTES
}

/** Limits the page needs to prepare images before sending (served in /config.json). */
export const IMAGE_LIMITS = Object.freeze({
  maxBase64Bytes: MAX_IMAGE_BASE64_BYTES,
  maxRawBytes: MAX_IMAGE_RAW_BYTES,
  maxRawBytesByType: Object.freeze(Object.fromEntries(IMAGE_MIME_TYPES.map((t) => [t, maxRawBytesFor(t)]))),
  maxDimension: MAX_IMAGE_DIMENSION,
  maxPerPrompt: MAX_IMAGES_PER_PROMPT,
  maxPerSession: MAX_IMAGES_PER_SESSION,
  mimeTypes: IMAGE_MIME_TYPES,
})
