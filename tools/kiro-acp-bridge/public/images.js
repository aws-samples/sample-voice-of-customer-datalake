// Browser-side image preparation: fit every image inside the model endpoint's
// limits BEFORE it is sent. The bridge re-checks the bytes (src/images.mjs);
// this file exists so the user gets a working image instead of a refusal.
//
// Why it matters: an image Kiro accepts but the endpoint refuses is kept in the
// session history and replayed every turn, wedging the session for good
// (kirodotdev/Kiro#11497: 5 MiB of base64 = 3.75 MiB raw; #11663: 2000 px).
// Kiro also re-encodes images, and PNGs can come out larger, so lossless
// formats get a tighter 2.5 MiB cap (see src/images.mjs for the measurements).

const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.6, 0.45]
const SHRINK_STEP = 0.75
const MIN_LONGEST_SIDE = 64

export class ImageRejected extends Error {}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
}

function encode(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

function drawScaled(bitmap, scale, background) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageRejected('This browser cannot resize images (no 2D canvas)')
  if (background) {
    ctx.fillStyle = background // JPEG has no alpha; transparent pixels would turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

function encodingAttempts(sourceType) {
  const jpeg = JPEG_QUALITIES.map((quality) => ({ type: 'image/jpeg', quality, background: '#fff' }))
  // Keep PNG lossless first (screenshots stay crisp), then fall back to JPEG
  return sourceType === 'image/png' ? [{ type: 'image/png' }, ...jpeg] : jpeg
}

async function result(name, blob, width, height, resized) {
  return { name, blob, mimeType: blob.type, data: await blobToBase64(blob), width, height, bytes: blob.size, resized }
}

/**
 * Returns an ACP-ready image: `{ name, blob, mimeType, data (base64), width, height, bytes, resized }`.
 * Images already inside the limits are sent untouched; larger ones are scaled to the
 * dimension cap and re-encoded (shrinking further if needed) until they fit.
 * @throws {ImageRejected}
 */
export async function prepareImage(file, limits) {
  if (!limits.mimeTypes.includes(file.type)) {
    throw new ImageRejected(`${file.name}: ${file.type || 'unknown type'} is not supported (PNG, JPEG, GIF or WebP)`)
  }
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageRejected(`${file.name}: not a readable image`)
  }
  try {
    const { width, height } = bitmap
    const longest = Math.max(width, height)
    const fitsBytes = (type, bytes) => bytes <= (limits.maxRawBytesByType?.[type] ?? limits.maxRawBytes)
    if (longest <= limits.maxDimension && fitsBytes(file.type, file.size)) {
      return await result(file.name, file, width, height, false)
    }
    let scale = Math.min(1, limits.maxDimension / longest)
    while (longest * scale >= MIN_LONGEST_SIDE) {
      const canvases = new Map() // one draw per background at this scale, reused across qualities
      for (const attempt of encodingAttempts(file.type)) {
        const key = attempt.background ?? ''
        if (!canvases.has(key)) canvases.set(key, drawScaled(bitmap, scale, attempt.background))
        const canvas = canvases.get(key)
        const blob = await encode(canvas, attempt.type, attempt.quality)
        // toBlob silently falls back to PNG for unsupported types, so check what came out
        if (blob && blob.type === attempt.type && fitsBytes(blob.type, blob.size)) {
          return await result(file.name, blob, canvas.width, canvas.height, true)
        }
      }
      scale *= SHRINK_STEP
    }
    throw new ImageRejected(`${file.name}: could not be compressed under the image size limit`)
  } finally {
    bitmap.close()
  }
}
