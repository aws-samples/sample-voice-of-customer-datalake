/**
 * @fileoverview svgToPng: an SVG logo becomes a PNG in the browser (longest side 1024 px), or a
 * typed error the UI can explain. The SVG is loaded from a `data:` URL, the one scheme the site's
 * CSP lets an image load besides 'self'.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDE, MAX_SVG_BYTES, isSvgConversionError, isSvgFile, parseViewBoxSize, svgToPngWith,
} from './svgToPng'
import type { RasterCanvas, RasterImage, SvgConversionReason, SvgToPngDeps } from './svgToPng'

class FakeImage implements RasterImage {
  readonly naturalWidth: number
  readonly naturalHeight: number
  private readonly decoded: () => Promise<void>

  constructor(naturalWidth: number, naturalHeight: number, decoded: () => Promise<void> = () => Promise.resolve()) {
    this.naturalWidth = naturalWidth
    this.naturalHeight = naturalHeight
    this.decoded = decoded
  }

  decode(): Promise<void> { return this.decoded() }
}

interface Harness {
  deps: SvgToPngDeps<FakeImage>
  sizes: Array<{ width: number; height: number }>
  loaded: string[]
}

function harness(image: FakeImage, toBlob: () => Promise<Blob | null> = () => Promise.resolve(new Blob(['png'], { type: 'image/png' }))): Harness {
  const sizes: Harness['sizes'] = []
  const loaded: string[] = []
  const createCanvas = (width: number, height: number): RasterCanvas<FakeImage> => {
    sizes.push({ width, height })
    return { drawImage: () => {}, toBlob }
  }
  return {
    sizes,
    loaded,
    deps: {
      readText: (file) => new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.readAsText(file)
      }),
      createImage: (url) => { loaded.push(url); return image },
      createCanvas,
      timeoutMs: 20,
    },
  }
}

const svgFile = (text = '<svg xmlns="http://www.w3.org/2000/svg"/>', name = 'mark.svg') => new File([text], name, { type: 'image/svg+xml' })

async function reasonOf(promise: Promise<unknown>): Promise<SvgConversionReason | 'resolved' | 'other'> {
  try {
    await promise
    return 'resolved'
  } catch (error) {
    return isSvgConversionError(error) ? error.reason : 'other'
  }
}

describe('svgToPng', () => {
  it('converts with the natural size and hands back a PNG file', async () => {
    const h = harness(new FakeImage(256, 256))
    const png = await svgToPngWith(svgFile(), h.deps)
    expect([png.type, png.name, h.sizes, h.loaded.length]).toStrictEqual(['image/png', 'mark.png', [{ width: 1024, height: 1024 }], 1])
  })

  it('uses the viewBox when the SVG has no natural size', async () => {
    const h = harness(new FakeImage(0, 0))
    await svgToPngWith(svgFile('<?xml version="1.0"?><svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"/>'), h.deps)
    expect(h.sizes).toStrictEqual([{ width: 1024, height: 512 }])
  })

  it(`falls back to a ${DEFAULT_SIDE} px square when there is neither size nor viewBox`, async () => {
    const h = harness(new FakeImage(0, 0))
    await svgToPngWith(svgFile(), h.deps)
    expect(h.sizes).toStrictEqual([{ width: 1024, height: 1024 }])
  })

  it('caps a large SVG at 1024 px and keeps its aspect', async () => {
    const h = harness(new FakeImage(4000, 1000))
    await svgToPngWith(svgFile(), h.deps)
    expect(h.sizes).toStrictEqual([{ width: 1024, height: 256 }])
  })

  it('rejects an SVG over 1 MB without reading it', async () => {
    const h = harness(new FakeImage(10, 10))
    const big = svgFile(`<svg>${'a'.repeat(MAX_SVG_BYTES)}</svg>`)
    expect(await reasonOf(svgToPngWith(big, h.deps))).toBe('too_large')
    expect(h.sizes).toStrictEqual([])
  })

  it('a decode that never finishes is a timeout error', async () => {
    const h = harness(new FakeImage(10, 10, () => new Promise(() => {})))
    expect(await reasonOf(svgToPngWith(svgFile(), h.deps))).toBe('timeout')
  })

  it('a decode that fails is an unreadable error', async () => {
    const h = harness(new FakeImage(10, 10, () => Promise.reject(new Error('EncodingError'))))
    expect(await reasonOf(svgToPngWith(svgFile(), h.deps))).toBe('unreadable')
  })

  it.each([
    ['returns null', () => Promise.resolve(null)],
    ['throws (tainted canvas)', () => Promise.reject(new Error('SecurityError'))],
  ])('toBlob that %s is a not-converted error', async (_label, toBlob) => {
    const h = harness(new FakeImage(10, 10), toBlob)
    expect(await reasonOf(svgToPngWith(svgFile(), h.deps))).toBe('not_converted')
  })

  it('a PNG over 5 MB is refused', async () => {
    const h = harness(new FakeImage(10, 10), () => Promise.resolve(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)])))
    expect(await reasonOf(svgToPngWith(svgFile(), h.deps))).toBe('result_too_large')
  })

  it('loads the SVG text from a data: URL typed image/svg+xml, even when the file had no type', async () => {
    const h = harness(new FakeImage(10, 10))
    const text = '<svg xmlns="http://www.w3.org/2000/svg"><title>Exämple Äir</title></svg>'
    await svgToPngWith(new File([text], 'logo.SVG'), h.deps)
    const [url] = h.loaded
    const prefix = 'data:image/svg+xml;base64,'
    expect(url?.startsWith(prefix)).toBe(true)
    const bytes = Uint8Array.from(atob(url?.slice(prefix.length) ?? ''), (char) => char.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe(text)
  })

  // Regression: a blob: URL was blocked by `img-src 'self' data:`, so every SVG failed as "unreadable".
  it("loads the SVG from a scheme the site's CSP img-src allows", async () => {
    const cdn = readFileSync(join(__dirname, '../../../lib/stacks/core-cdn.ts'), 'utf8')
    const imgSrc = /img-src ([^;]+);/.exec(cdn)?.[1]?.split(/\s+/) ?? []
    const h = harness(new FakeImage(10, 10))
    await svgToPngWith(svgFile(), h.deps)
    const scheme = `${(h.loaded[0] ?? '').split(':')[0] ?? ''}:`
    expect(imgSrc).toContain(scheme)
  })
})

describe('parseViewBoxSize', () => {
  it.each([
    ['<svg viewBox="0 0 48 24">', { width: 48, height: 24 }],
    ["<svg width='100%' viewBox='-5,-5, 10.5 2e1'>", { width: 10.5, height: 20 }],
    ['<!-- x --><svg\n  viewBox = " 0 0 1 1 " >', { width: 1, height: 1 }],
  ])('reads %s', (text, size) => {
    expect(parseViewBoxSize(text)).toStrictEqual(size)
  })

  it.each([
    '<svg viewBox="0 0 0 10">',
    '<svg viewBox="0 0 -4 10">',
    '<svg viewBox="0 0 10">',
    '<svg viewBox="a b c d">',
    '<svg><g viewBox="0 0 10 10"/></svg>',
    'no svg here',
  ])('refuses %s', (text) => {
    expect(parseViewBoxSize(text)).toBeNull()
  })
})

describe('isSvgFile', () => {
  it.each([
    [{ type: 'image/svg+xml', name: 'a' }, true],
    [{ type: '', name: 'mark.SVG' }, true],
    [{ type: 'image/png', name: 'mark.svg' }, false],
    [{ type: '', name: 'mark.png' }, false],
  ])('%o → %s', (file, expected) => {
    expect(isSvgFile(file)).toBe(expected)
  })
})
