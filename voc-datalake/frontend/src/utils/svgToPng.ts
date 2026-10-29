/**
 * @fileoverview Rasterise an SVG logo to PNG in the browser.
 *
 * The logo upload route accepts PNG, JPEG and WebP only and REFUSES SVG: an SVG is a
 * document that can carry script. A company whose logo is an .svg is converted here,
 * then the PNG goes through the ordinary upload — the SVG bytes never leave the browser.
 *
 * Why this is safe: the SVG is loaded through an `Image` (an <img> never runs SVG
 * script nor fetches external resources) from a same-document blob URL, drawn on a
 * canvas with a transparent background, and read back with `toBlob('image/png')`.
 *
 * Browsers differ (see docs/company-context.md → Storage): some taint the canvas for an SVG
 * with a <foreignObject> (toBlob throws or yields null), and some refuse to draw an SVG
 * that has no intrinsic size. Every such failure is a {@link SvgConversionError} whose
 * `reason` the UI explains ("export it as PNG and upload that").
 *
 * The browser objects are injected (`createImage`, `createCanvas`) because jsdom has no canvas.
 *
 * @module utils/svgToPng
 */

const MB = 1024 * 1024
/** The largest SVG the converter reads. */
export const MAX_SVG_BYTES = MB
/** The largest PNG it hands back (the logo route's own cap). */
const MAX_PNG_BYTES = 5 * MB
/** The longest side of the PNG, in px: small logos are scaled up for crispness, large ones down. */
const TARGET_LONGEST_SIDE = 1024
/** The size assumed when the SVG states none at all (no width/height, no viewBox). */
export const DEFAULT_SIDE = 512
const DEFAULT_TIMEOUT_MS = 8000

export type SvgConversionReason = 'too_large' | 'unreadable' | 'timeout' | 'not_converted' | 'result_too_large'

/** Why an SVG could not be turned into a PNG; the UI maps `reason` to a message. */
export class SvgConversionError extends Error {
  readonly reason: SvgConversionReason

  constructor(reason: SvgConversionReason, cause?: unknown) {
    super(`SVG conversion failed: ${reason}`, { cause })
    this.name = 'SvgConversionError'
    this.reason = reason
  }
}

export function isSvgConversionError(value: unknown): value is SvgConversionError {
  return value instanceof SvgConversionError
}

/** True for an SVG file: by its type, or by its name when the OS reported no type. */
export function isSvgFile(file: Pick<File, 'type' | 'name'>): boolean {
  if (file.type === 'image/svg+xml') return true
  return file.type === '' && /\.svg$/i.test(file.name)
}

/** What the converter needs from an <img> loading the SVG. */
export interface RasterImage {
  readonly naturalWidth: number
  readonly naturalHeight: number
  decode(): Promise<void>
}

/** What the converter needs from a sized canvas. */
export interface RasterCanvas<I extends RasterImage> {
  /** Paint `image` at 0,0 scaled to the canvas size, over a transparent background. */
  drawImage(image: I): void
  toBlob(type: 'image/png'): Promise<Blob | null>
}

export interface SvgToPngDeps<I extends RasterImage> {
  readText: (file: File) => Promise<string>
  /** An image that starts loading `url` (an <img> never runs SVG script). */
  createImage: (url: string) => I
  createCanvas: (width: number, height: number) => RasterCanvas<I>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  timeoutMs: number
}

function browserCanvas(width: number, height: number): RasterCanvas<HTMLImageElement> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return {
    drawImage(image) {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.clearRect(0, 0, width, height)
      context.drawImage(image, 0, 0, width, height)
    },
    toBlob: (type) => new Promise((resolve) => { canvas.toBlob(resolve, type) }),
  }
}

function browserImage(url: string): HTMLImageElement {
  const image = new Image()
  image.src = url
  return image
}

const BROWSER_DEPS: SvgToPngDeps<HTMLImageElement> = {
  readText: (file) => file.text(),
  createImage: browserImage,
  createCanvas: browserCanvas,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`
const SEP = String.raw`(?:\s+|\s*,\s*)`
/** The root <svg …> start tag (the first one in the text). */
const ROOT_TAG_RE = /<svg\b[^>]*>/i
/** `viewBox="min-x min-y width height"` inside that tag: exactly four numbers. */
const VIEWBOX_RE = new RegExp(String.raw`\sviewBox\s*=\s*(["'])\s*${NUMBER}${SEP}${NUMBER}${SEP}(${NUMBER})${SEP}(${NUMBER})\s*\1`, 'i')

interface Size { width: number; height: number }

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/** The root viewBox's width and height, or null when it is absent, malformed or not positive. */
export function parseViewBoxSize(svgText: string): Size | null {
  const rootTag = ROOT_TAG_RE.exec(svgText)
  const match = rootTag ? VIEWBOX_RE.exec(rootTag[0]) : null
  if (!match) return null
  const width = Number(match[2])
  const height = Number(match[3])
  return positive(width) && positive(height) ? { width, height } : null
}

/** The source size: the image's natural size, else the viewBox, else a square default. */
function sourceSize(image: RasterImage, svgText: string): Size {
  if (positive(image.naturalWidth) && positive(image.naturalHeight)) return { width: image.naturalWidth, height: image.naturalHeight }
  return parseViewBoxSize(svgText) ?? { width: DEFAULT_SIDE, height: DEFAULT_SIDE }
}

/** Scale so the longest side is exactly {@link TARGET_LONGEST_SIDE}, keeping the aspect (each side ≥ 1 px). */
function targetSize(source: Size): Size {
  const scale = TARGET_LONGEST_SIDE / Math.max(source.width, source.height)
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
}

function decodeWithin(image: RasterImage, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SvgConversionError('timeout')), timeoutMs)
    image.decode().then(
      () => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(new SvgConversionError('unreadable', error)) },
    )
  })
}

async function rasterise<I extends RasterImage>(image: I, size: Size, deps: SvgToPngDeps<I>): Promise<Blob> {
  try {
    const canvas = deps.createCanvas(size.width, size.height)
    canvas.drawImage(image)
    const blob = await canvas.toBlob('image/png')
    if (blob) return blob
  } catch (error) {
    throw new SvgConversionError('not_converted', error)
  }
  throw new SvgConversionError('not_converted')
}

function pngName(name: string): string {
  const base = name.replace(/\.svg$/i, '')
  return `${base || 'logo'}.png`
}

/**
 * Convert an SVG file to a PNG `File` (longest side 1024 px, transparent background).
 * Throws {@link SvgConversionError} for every failure; the blob URL is always revoked.
 */
export async function svgToPng(file: File, deps: SvgToPngDeps<HTMLImageElement> = BROWSER_DEPS): Promise<File> {
  return svgToPngWith(file, deps)
}

/** {@link svgToPng} over any image/canvas implementation (the specs pass fakes). */
export async function svgToPngWith<I extends RasterImage>(file: File, deps: SvgToPngDeps<I>): Promise<File> {
  if (file.size > MAX_SVG_BYTES) throw new SvgConversionError('too_large')
  const svgText = await deps.readText(file)
  const url = deps.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    const image = deps.createImage(url)
    await decodeWithin(image, deps.timeoutMs)
    const png = await rasterise(image, targetSize(sourceSize(image, svgText)), deps)
    if (png.size > MAX_PNG_BYTES) throw new SvgConversionError('result_too_large')
    return new File([png], pngName(file.name), { type: 'image/png' })
  } finally {
    deps.revokeObjectURL(url)
  }
}
