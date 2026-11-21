/**
 * @fileoverview A picked text file in a spec: jsdom's `File` has no `.text()`, which the upload dialogs and the import
 * wizard read a file with, and the page's one file input to pick it with.
 *
 * @module test/textFiles
 */

/** A `File` named `name` whose `.text()` answers `content`. */
export function textFile(content: string, name: string, type = 'text/csv'): File {
  const file = new File([content], name, { type })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  return file
}

/** The page's file input (a spec fails when there is none). */
export function pageFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}
