/**
 * @fileoverview What the upload refuses in the browser (libraryFormats.ts, in lockstep with
 * lambda/shared/library_extract.py FORMATS): a file's type read from its extension first, the size caps, the short
 * name the server would make, and the tags as typed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCEPT_ATTR, LIBRARY_FORMATS, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, checkFile, contentTypeOf, isSlug, parseTags, slugify,
  tagsProblem, titleFromFilename,
} from './libraryFormats'

const file = (name: string, type: string, size = 10) => ({ name, type, size })

const EXTRACT_PY = resolve(__dirname, '../../../../lambda/shared/library_extract.py')

/** library_extract.py FORMATS as written: `'<content type>': Format('<format>', '<kind>'),` one per line. */
function backendFormats(): Record<string, string> {
  const formats: Record<string, string> = {}
  for (const [, contentType = '', format = ''] of readFileSync(EXTRACT_PY, 'utf8').matchAll(/^ {4}'([a-z./+-]+)': Format\('(\w+)', '\w+'\),$/gm)) {
    formats[contentType] = format
  }
  return formats
}

describe('the accepted formats', () => {
  it('names every content type of library_extract.py FORMATS with its format', () => {
    const backend = backendFormats()
    expect(Object.keys(backend)).toHaveLength(14)
    expect(LIBRARY_FORMATS).toStrictEqual(backend)
  })

  it('holds the backend size caps', () => {
    const source = readFileSync(EXTRACT_PY, 'utf8')
    expect(source).toContain('MAX_UPLOAD_BYTES: Final = 25 * 1024 * 1024')
    expect(source).toContain('MAX_NATIVE_IMAGE_BYTES: Final = 3_750_000')
    expect([MAX_UPLOAD_BYTES, MAX_IMAGE_BYTES]).toStrictEqual([25 * 1024 * 1024, 3_750_000])
  })

  it('lets the picker offer every type and extension', () => {
    expect(ACCEPT_ATTR.split(',')).toStrictEqual(expect.arrayContaining(['application/pdf', '.md', '.pptx', '.jpg', 'image/webp']))
  })
})

describe('contentTypeOf', () => {
  it.each([
    ['report.PDF', '', 'application/pdf'],
    ['notes.md', '', 'text/markdown'],
    ['notes.markdown', 'text/x-markdown', 'text/markdown'],
    // Windows names a CSV a legacy Excel file: the extension wins.
    ['export.csv', 'application/vnd.ms-excel', 'text/csv'],
    ['photo.jpg', 'image/jpeg', 'image/jpeg'],
    ['deck', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('reads %s (%s) as %s', (name, type, expected) => {
    expect(contentTypeOf(file(name, type))).toBe(expected)
  })

  it('takes no type the library does not', () => {
    expect([contentTypeOf(file('archive.zip', 'application/zip')), contentTypeOf(file('.env', 'text/x-env'))]).toStrictEqual([null, null])
  })
})

describe('checkFile', () => {
  it('accepts a file with its type and format', () => {
    expect(checkFile(file('q3.pdf', 'application/pdf', 1000))).toStrictEqual({ ok: true, contentType: 'application/pdf', format: 'pdf' })
  })

  it.each([
    [file('song.mp3', 'audio/mpeg'), 'unsupported'],
    [file('empty.txt', 'text/plain', 0), 'empty'],
    [file('big.pdf', 'application/pdf', MAX_UPLOAD_BYTES + 1), 'tooLarge'],
    [file('big.png', 'image/png', MAX_IMAGE_BYTES + 1), 'imageTooLarge'],
  ])('refuses %o as %s', (candidate, reason) => {
    expect(checkFile(candidate)).toStrictEqual({ ok: false, reason })
  })

  it('accepts a file exactly at its cap', () => {
    expect([checkFile(file('a.pdf', '', MAX_UPLOAD_BYTES)).ok, checkFile(file('a.webp', '', MAX_IMAGE_BYTES)).ok]).toStrictEqual([true, true])
  })
})

describe('titles and short names', () => {
  it('titles a file by its name without the extension', () => {
    expect([titleFromFilename('Q3 Market Report.pdf'), titleFromFilename('.hidden'), titleFromFilename('README')]).toStrictEqual(['Q3 Market Report', '.hidden', 'README'])
  })

  it.each([
    ['Q3 Market Report', 'q3-market-report'],
    ['  --Café déjà vu!  ', 'cafe-deja-vu'],
    ['日本', 'document'],
    ['a'.repeat(63) + ' b', 'a'.repeat(63)],
  ])('makes %s into %s, as the server does', (title, slug) => {
    expect(slugify(title)).toBe(slug)
  })

  it('knows a short name', () => {
    expect(['q3-market', 'a', '-q3', 'q3-', 'Q3', 'q'.repeat(65)].map(isSlug)).toStrictEqual([true, true, false, false, false, false])
  })
})

describe('tags', () => {
  it('reads a typed list of tags', () => {
    expect(parseTags(' Market,  q3   report ,,market ')).toStrictEqual(['market', 'q3 report'])
  })

  it('says what is wrong with them', () => {
    expect([
      tagsProblem(['a']), tagsProblem(Array.from({ length: 11 }, (_, index) => `t${String(index)}`)), tagsProblem(['x'.repeat(41)]),
    ]).toStrictEqual([null, 'tooMany', 'tooLong'])
  })
})
