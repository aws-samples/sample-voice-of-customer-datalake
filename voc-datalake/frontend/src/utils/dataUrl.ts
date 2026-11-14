/**
 * @fileoverview Bytes → `data:` URL.
 *
 * The site's CSP allows images from `'self'` and `data:` only (lib/stacks/core-cdn.ts): a
 * `blob:` URL is blocked, so any image the page builds in memory is handed over as a `data:` URL.
 *
 * @module utils/dataUrl
 */

/** Bytes per `String.fromCharCode` call: a 5 MB spread would overflow the call stack. */
const CHUNK = 0x8000

/**
 * `bytes` as a `data:<type>;base64,` URL. Built from the raw bytes, not a Blob + FileReader: the
 * Blob a fetch answer yields is not always the Blob class FileReader accepts (Node 22's undici
 * under jsdom refused it in CI), and the bytes are all a data: URL needs.
 */
export function bytesToDataUrl(bytes: Uint8Array, type: string): string {
  const chunks = Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, index) =>
    String.fromCharCode(...bytes.subarray(index * CHUNK, (index + 1) * CHUNK)))
  return `data:${type};base64,${btoa(chunks.join(''))}`
}

/** `text` (UTF-8) as a `data:<type>;base64,` URL. */
export function textToDataUrl(text: string, type: string): string {
  return bytesToDataUrl(new TextEncoder().encode(text), type)
}
