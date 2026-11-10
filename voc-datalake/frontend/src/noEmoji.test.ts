/**
 * No emoji in the UI (owner request, 2026-10-05): sources, headings and status
 * cues use the lucide icon set the navigation uses (see components/SourceIcon).
 *
 * Scanned, because each one reaches a user:
 * - application code under `src/` (tests and test fixtures excluded), with
 *   comments stripped first — a comment is never rendered;
 * - every locale file under `public/locales/` (each string is rendered);
 * - every plugin manifest's `icon` (the Settings/Scrapers cards map these words
 *   to icons, and an emoji word would fall back to a generic glyph).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import * as path from 'path'

const FRONTEND_DIR = path.join(__dirname, '..')
const SRC_DIR = path.join(FRONTEND_DIR, 'src')
const LOCALES_DIR = path.join(FRONTEND_DIR, 'public', 'locales')
const PLUGINS_DIR = path.join(FRONTEND_DIR, '..', 'plugins')

const EMOJI = /\p{Extended_Pictographic}/u
const SOURCE_FILE = /\.(ts|tsx)$/
const NOT_APP_CODE = /(\.test\.|[/\\]test[/\\]|fixtures?\.|[/\\]__fixtures__[/\\])/

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return filesUnder(full, keep)
    return keep(full) ? [full] : []
  })
}

/**
 * Source text with block comments blanked. Newlines inside a comment are kept
 * so reported line numbers still match the file. An index scan, not a regex:
 * a lazy `[\s\S]*?` backtracks on long files.
 */
function withoutBlockComments(source: string): string {
  const start = source.indexOf('/*')
  if (start === -1) return source
  const end = source.indexOf('*/', start + 2)
  const stop = end === -1 ? source.length : end + 2
  const blanked = source.slice(start, stop).replace(/[^\n]/g, '')
  return source.slice(0, start) + blanked + withoutBlockComments(source.slice(stop))
}

/** Characters that, right before `//`, mean it is a URL or a string, not a comment. */
const NOT_A_COMMENT_BEFORE = ':\'"`'

/** Index of the first `//` that starts a line comment, or -1. */
function lineCommentStart(line: string, from = 0): number {
  const index = line.indexOf('//', from)
  if (index <= 0) return index
  return NOT_A_COMMENT_BEFORE.includes(line.charAt(index - 1)) ? lineCommentStart(line, index + 1) : index
}

/** Source text without block comments and `//` line comments (a `//` inside a URL string is kept). */
function withoutComments(source: string): string {
  return withoutBlockComments(source)
    .split('\n')
    .map((line) => {
      const start = lineCommentStart(line)
      return start === -1 ? line : line.slice(0, start)
    })
    .join('\n')
}

function emojiLines(text: string): number[] {
  return text.split('\n').flatMap((line, index) => (EMOJI.test(line) ? [index + 1] : []))
}

describe('no emoji in the UI', () => {
  it('application code renders no emoji', () => {
    const offenders = filesUnder(SRC_DIR, (file) => SOURCE_FILE.test(file) && !NOT_APP_CODE.test(file))
      .flatMap((file) => emojiLines(withoutComments(readFileSync(file, 'utf8')))
        .map((line) => `${path.relative(SRC_DIR, file)}:${line}`))
    expect(offenders).toStrictEqual([])
  })

  it('no locale string contains an emoji', () => {
    const offenders = filesUnder(LOCALES_DIR, (file) => file.endsWith('.json'))
      .flatMap((file) => emojiLines(readFileSync(file, 'utf8'))
        .map((line) => `${path.relative(LOCALES_DIR, file)}:${line}`))
    expect(offenders).toStrictEqual([])
  })

  it('every plugin manifest icon is a word, not an emoji', () => {
    const icons = readdirSync(PLUGINS_DIR)
      .map((id) => path.join(PLUGINS_DIR, id, 'manifest.json'))
      .filter((file) => {
        try { return statSync(file).isFile() } catch { return false }
      })
      .map((file) => {
        const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'))
        const icon = typeof manifest === 'object' && manifest !== null && 'icon' in manifest ? manifest.icon : undefined
        return { file: path.relative(PLUGINS_DIR, file), icon }
      })
    expect(icons.length).toBeGreaterThan(0)
    expect(icons.filter(({ icon }) => typeof icon !== 'string' || EMOJI.test(icon))).toStrictEqual([])
  })
})
