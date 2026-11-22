/**
 * @fileoverview A picked text file in a spec: jsdom's `File` has no `.text()` or `.arrayBuffer()`, which the upload
 * dialogs and the import wizard read a file with, and the page's one file input to pick it with.
 *
 * @module test/textFiles
 */

/** A `File` named `name` whose `.text()` answers `content`, and `.arrayBuffer()` its UTF-8 bytes. */
export function textFile(content: string, name: string, type = 'text/csv'): File {
  const file = new File([content], name, { type })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new TextEncoder().encode(content).buffer) })
  return file
}

/** The page's file input (a spec fails when there is none). */
export function pageFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}
