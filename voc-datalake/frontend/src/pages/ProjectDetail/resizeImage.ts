/**
 * Browser-side image preparation for product-doc uploads.
 *
 * WHY THIS EXISTS AT ALL: the upload boundary caps images at the Bedrock
 * Converse per-image limit (3.75 MB), which is well under the 10 MiB general
 * file cap. A phone screenshot routinely exceeds it. Refusing those uploads
 * would be correct but useless — the browser can already decode and re-encode
 * the image, so it can hand the API something that fits.
 *
 * WHY IT IS A SEPARATE MODULE: it is the only part of the upload path with
 * non-trivial logic (a degrade ladder with a byte target), and it can be tested
 * against fake imaging primitives without rendering the component.
 *
 * THE CONTRACT WITH THE SERVER, which is what makes the return shape what it is:
 * the presigned PUT now signs `ContentLength` from the `size_bytes` the client
 * declares, so the body PUT to S3 must be byte-for-byte the size that was
 * declared. Callers must therefore declare THIS blob's size, never the original
 * File's. Everything needed to describe the produced blob truthfully — bytes,
 * size, content type, filename extension — is returned together for that reason.
 */

/**
 * Max bytes for one image in a Bedrock Converse message.
 *
 * Source of truth is `lib/utils/model-allowlist.ts` (mirrored for the Lambdas in
 * `lambda/shared/image_limits.py`); neither is importable from the frontend
 * bundle, so the number is repeated here. It is a limit of the Converse API's
 * message shape rather than of any single model, so the admin model picker
 * cannot move it.
 *
 * PINNED to those two by `lambda/shared/test/test_image_limits_lockstep.py`,
 * which reads this line as SOURCE TEXT — so keep it a plain
 * `export const NAME = <number>` on one line. A CLIENT cap above the SERVER cap
 * is not a cosmetic disagreement: the ladder below would happily stop at a size
 * the API then refuses, which is exactly the "the upload appears to work, then
 * 400s" failure this rung exists to remove.
 */
export const MAX_IMAGE_BYTES = 3_750_000

/**
 * Long-edge ceiling, in pixels, for an image sent to the model.
 *
 * Claude downscales anything larger than roughly this on the long edge before
 * the model ever sees it, so bytes spent above this buy nothing: they cost
 * upload time and cap headroom and are then thrown away server-side.
 *
 * NOT a limit, and it has no server-side counterpart to be pinned against — the
 * server's pixel cap is MAX_IMAGE_DIMENSION_PX (8000), an entirely different
 * number for an entirely different purpose. This one is a quality/cost target
 * chosen from model behaviour, so nothing rejects an image for exceeding it. Do
 * not "restore" a lockstep test for it by inventing a server constant to match.
 */
export const MAX_IMAGE_EDGE_PX = 1568

/** Content types this module can decode and re-encode. */
type ImageContentType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/**
 * Extension per content type. The S3 key is built from the content type the
 * client declares, so a blob whose extension disagrees with its real bytes
 * produces an object that lies about itself.
 */
const IMAGE_EXTENSIONS: Readonly<Record<ImageContentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function isImageContentType(value: string): value is ImageContentType {
  return Object.hasOwn(IMAGE_EXTENSIONS, value)
}

/** One rung of the degrade ladder. `quality` is ignored for PNG. */
interface EncodeStep {
  readonly type: 'image/png' | 'image/jpeg'
  readonly quality?: number
  readonly maxEdge: number
}

/**
 * Tried in order; the first result under MAX_IMAGE_BYTES wins.
 *
 * PNG FIRST, and this is load-bearing rather than a preference: the point of
 * uploading a screenshot is that the model reproduces the UI labels in it
 * verbatim, and JPEG ringing around small text is exactly what corrupts short
 * strings. PNG also keeps alpha for free. JPEG is a fallback for images that
 * cannot fit any other way — a photographic screenshot at 1568 px really can
 * approach 3.75 MB as PNG, so the ladder is not hypothetical.
 *
 * Resolution is only dropped after quality, because dropping pixels loses the
 * small text outright while quality loss merely blurs it.
 */
const ENCODE_LADDER: readonly EncodeStep[] = [
  { type: 'image/png', maxEdge: MAX_IMAGE_EDGE_PX },
  { type: 'image/jpeg', quality: 0.85, maxEdge: MAX_IMAGE_EDGE_PX },
  { type: 'image/jpeg', quality: 0.7, maxEdge: MAX_IMAGE_EDGE_PX },
  { type: 'image/jpeg', quality: 0.7, maxEdge: 1200 },
  { type: 'image/jpeg', quality: 0.6, maxEdge: 1024 },
]

/** Why preparation failed, in the two cases a user can act on. */
export type ImagePrepFailure = 'unreadable' | 'too-large'

/**
 * Thrown when an image cannot be made uploadable.
 *
 * Typed rather than a bare Error so the caller can pick the right message
 * without matching on English text. The server would refuse these uploads
 * anyway; this only makes the refusal legible before the round trip.
 */
export class ImagePrepError extends Error {
  readonly failure: ImagePrepFailure

  constructor(failure: ImagePrepFailure, message: string) {
    super(message)
    this.name = 'ImagePrepError'
    this.failure = failure
  }
}

export function isImagePrepError(value: unknown): value is ImagePrepError {
  return value instanceof ImagePrepError
}

/** Everything the caller needs to declare the truth to the upload API. */
export interface PreparedUpload {
  readonly blob: Blob
  /** Original name, with the extension corrected to match `contentType`. */
  readonly filename: string
  readonly contentType: string
  /** Always `blob.size`. Declare this to the API, not the source File's size. */
  readonly sizeBytes: number
  /** Pixel dimensions of `blob`, or null when it was not an image. */
  readonly width: number | null
  readonly height: number | null
  /** False when `blob` IS the input file (non-image, or already small enough). */
  readonly reencoded: boolean
}

/** Replace the extension so it matches the bytes actually produced. */
function withExtensionFor(filename: string, contentType: ImageContentType): string {
  const base = filename.replace(/\.[^./\\]+$/, '')
  return `${base || 'image'}.${IMAGE_EXTENSIONS[contentType]}`
}

/**
 * Scale to fit `maxEdge` on the long side.
 *
 * NEVER upscales, and the early return is the only thing that guarantees it —
 * load-bearing, because an image over the byte cap but under the pixel ceiling
 * walks the whole ladder, whose first rungs sit at MAX_IMAGE_EDGE_PX. Without
 * it a 900 px screenshot would come back enlarged to 1568 px: more bytes, no
 * more detail, and Claude would downscale it again anyway.
 */
function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxEdge) return { width, height }
  const scale = maxEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** A decoded image plus the cleanup its decoding path needs. */
interface DecodedImage {
  readonly source: CanvasImageSource
  readonly width: number
  readonly height: number
  release(): void
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new ImagePrepError('unreadable', 'image decode failed'))
    img.src = url
  })
}

/**
 * Decode via createImageBitmap where available, else an <img> element.
 *
 * createImageBitmap is the better path (it decodes off the main thread and needs
 * no object URL), but it only reached Safari in 15, so the element path stays as
 * a fallback rather than silently refusing older browsers.
 */
async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file).catch(() => {
      throw new ImagePrepError('unreadable', 'image decode failed')
    })
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(file)
  const img = await loadImageElement(url).catch((error: unknown) => {
    URL.revokeObjectURL(url)
    throw error
  })
  return {
    source: img,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    // Revoked only after the last draw: revoking earlier can invalidate the
    // element's own decoded data in some browsers.
    release: () => URL.revokeObjectURL(url),
  }
}

/** The subset of a 2D context this module uses, shared by both canvas flavours. */
interface Painter {
  fillStyle: string | CanvasGradient | CanvasPattern
  fillRect(x: number, y: number, w: number, h: number): void
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void
}

function paint(
  ctx: Painter,
  source: CanvasImageSource,
  width: number,
  height: number,
  type: string,
): void {
  if (type === 'image/jpeg') {
    // A fresh canvas is transparent black, and JPEG has no alpha channel — so
    // every transparent pixel of a PNG screenshot would come out solid black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(source, 0, 0, width, height)
}

function encodeViaElement(
  source: CanvasImageSource,
  width: number,
  height: number,
  step: EncodeStep,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImagePrepError('unreadable', 'canvas 2d context unavailable')
  paint(ctx, source, width, height, step.type)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new ImagePrepError('unreadable', `encode to ${step.type} failed`))
      },
      step.type,
      step.quality,
    )
  })
}

/**
 * Both halves are checked, not just the constructor: Safari shipped
 * OffscreenCanvas before `convertToBlob`, so the constructor's presence alone
 * does not mean the encode path works.
 */
function supportsOffscreenEncoding(): boolean {
  return typeof OffscreenCanvas === 'function'
    && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
}

async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
  step: EncodeStep,
): Promise<Blob> {
  if (!supportsOffscreenEncoding()) {
    return encodeViaElement(source, width, height, step)
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImagePrepError('unreadable', 'canvas 2d context unavailable')
  paint(ctx, source, width, height, step.type)
  return canvas.convertToBlob({ type: step.type, quality: step.quality }).catch(() => {
    throw new ImagePrepError('unreadable', `encode to ${step.type} failed`)
  })
}

function passThrough(file: File, width: number | null, height: number | null): PreparedUpload {
  return {
    blob: file,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    width,
    height,
    reencoded: false,
  }
}

async function runLadder(decoded: DecodedImage, file: File): Promise<PreparedUpload> {
  for (const step of ENCODE_LADDER) {
    // A rung's maxEdge is a ceiling, not a target: fitWithin never upscales, so
    // an image already under it walks the ladder at its own size.
    const size = fitWithin(decoded.width, decoded.height, step.maxEdge)
    const blob = await encode(decoded.source, size.width, size.height, step)
    if (blob.size <= MAX_IMAGE_BYTES) {
      return {
        blob,
        filename: withExtensionFor(file.name, step.type),
        contentType: step.type,
        sizeBytes: blob.size,
        width: size.width,
        height: size.height,
        reencoded: true,
      }
    }
  }
  throw new ImagePrepError(
    'too-large',
    `image is still over ${MAX_IMAGE_BYTES} bytes after the lowest quality step`,
  )
}

/**
 * Make `file` uploadable, or throw ImagePrepError.
 *
 * Non-images and images already within both limits are returned untouched —
 * re-encoding them would cost quality for nothing, and for an animated GIF it
 * would silently flatten the animation to its first frame.
 */
export async function resizeImageForUpload(file: File): Promise<PreparedUpload> {
  if (!isImageContentType(file.type)) return passThrough(file, null, null)

  const decoded = await decodeImage(file)
  try {
    const withinPixels = Math.max(decoded.width, decoded.height) <= MAX_IMAGE_EDGE_PX
    if (withinPixels && file.size <= MAX_IMAGE_BYTES) {
      return passThrough(file, decoded.width, decoded.height)
    }
    return await runLadder(decoded, file)
  } finally {
    decoded.release()
  }
}
