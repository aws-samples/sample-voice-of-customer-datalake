/**
 * @fileoverview Fake imaging primitives for the specs that drive `resizeImage`.
 *
 * jsdom has no image codec, so `OffscreenCanvas` and `createImageBitmap` are
 * stubbed. Only the primitives are faked — what each spec tests is the module's
 * response to the sizes the fake encoder reports. Shared by the DocsUpload and
 * ImportPersonaModal specs, which used to carry identical copies.
 */
import { vi, expect } from 'vitest'
import { fireEvent } from '@testing-library/react'

/** The zone's hidden file input — the control `user.upload` drives. */
export function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}

/** The first `selector` match inside `zone`, as the element a drag can leave towards. */
export function zoneChild(zone: HTMLElement, selector: string): HTMLElement {
  const child = zone.querySelector(selector)
  if (!(child instanceof HTMLElement)) throw new Error('zone child not found')
  return child
}

/**
 * The picker `accept` list offers the four image types and never PDF.
 *
 * Presence half first: an empty or missing accept attribute would trivially
 * satisfy "does not contain pdf" while letting the OS picker offer every file type.
 */
export function expectAcceptsImagesNotPdf(accept: string) {
  expect(accept).toContain('image/png')
  expect(accept).toContain('image/jpeg')
  expect(accept).toContain('image/gif')
  expect(accept).toContain('image/webp')
  expect(accept).not.toContain('pdf')
}

/** A 2d context that accepts fills and draws and records nothing. */
function inertContext2d() {
  return { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined }
}

/**
 * Encoder whose output is half a byte per pixel — under the 3.75 MB cap at
 * 1568 px, so the first (PNG) rung of the degrade ladder wins and the declared
 * size is a resized one.
 */
class FakeOffscreenCanvas {
  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(contextId: string) {
    if (contextId !== '2d') return null
    return inertContext2d()
  }

  convertToBlob(options: { type: string }): Promise<Blob> {
    const bytes = Math.round((this.width * this.height) / 2)
    return Promise.resolve(new Blob([new Uint8Array(bytes)], { type: options.type }))
  }
}

/** Encoder whose every output reports 3.9 MB, so no rung of the ladder fits the cap. */
class OversizedOffscreenCanvas {
  getContext() {
    return inertContext2d()
  }

  convertToBlob(options: { type: string }): Promise<Blob> {
    const blob = new Blob([new Uint8Array(8)], { type: options.type })
    Object.defineProperty(blob, 'size', { value: 3_900_000 })
    return Promise.resolve(blob)
  }
}

/** Stubs the decoder to yield a bitmap of the given dimensions. */
function stubDecoder(width: number, height: number) {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({
    width, height, close: () => undefined,
  })))
}

/** Stubs encoder and decoder so a `width`×`height` source resizes under the cap. */
export function stubImaging(width: number, height: number) {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  stubDecoder(width, height)
}

/** Stubs encoder and decoder so a 4000×3000 source is still too large after every rung. */
export function stubOversizedImaging() {
  vi.stubGlobal('OffscreenCanvas', OversizedOffscreenCanvas)
  stubDecoder(4000, 3000)
}

/** Stubs the decoder to reject, as a corrupt file would. */
export function stubUnreadableImage() {
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('bad bytes'))))
}

/** A File whose reported size is set independently of its actual bytes. */
export function imageFile(name: string, type: string, sizeBytes: number): File {
  const file = new File([new Uint8Array(8)], name, { type })
  Object.defineProperty(file, 'size', { value: sizeBytes })
  return file
}

/** A paste carrying only plain text — the case an image handler must leave alone. */
export function pasteText(target: HTMLElement) {
  return fireEvent.paste(target, {
    clipboardData: {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    },
  })
}

/** A paste carrying `files`, each also listed as a `file` clipboard item. */
export function pasteFiles(target: HTMLElement, files: readonly File[], kind = 'file') {
  return fireEvent.paste(target, {
    clipboardData: {
      items: files.map((file) => ({ kind, type: file.type, getAsFile: () => file })),
      files,
    },
  })
}
