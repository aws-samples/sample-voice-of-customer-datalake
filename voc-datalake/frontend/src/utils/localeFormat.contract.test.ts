/**
 * Dates and numbers follow the app language, never US English or the browser (verify10:
 * a Polish UI showed "Oct 18, 2026", "10/17/2026, 5:32:27 PM" and "+0.08").
 *
 * Every date goes through `utils/dateUtils` and every number through `utils/numberFormat`
 * (or `Intl` with the i18n language). This contract scans the source as text and fails on
 * the spellings that ignore the language:
 * - an `'en-US'` literal;
 * - `toLocaleString()` / `toLocaleDateString()` / `toLocaleTimeString()` with no locale
 *   (they follow the BROWSER, not the app language);
 * - `Intl.*Format()` / `Intl.*Format(undefined, …)` (same; `Intl.DateTimeFormat().resolvedOptions()`
 *   for the time zone is fine);
 * - date-fns `format` outside `utils/dateUtils.ts` (its patterns are English month names).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

/**
 * Files owned by a parallel track that still format without the language. Each entry is
 * PENDING, not allowed: the last test fails once the file is fixed, so the entry must go.
 */
const PENDING: Readonly<Record<string, string>> = {}

const RULES: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['en-US literal', /['"`]en-US['"`]/u],
  ['locale-less toLocale*String()', /\.toLocale(?:Date|Time)?String\(\s*\)/u],
  ['Intl format without a locale', /Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat|PluralRules|ListFormat)\(\s*(?:undefined\b|\)(?!\.resolvedOptions\(\)\.timeZone))/u],
  ['date-fns format outside utils/dateUtils', /import\s*\{[^}]*\bformat\b[^}]*\}\s*from\s*['"]date-fns['"]/u],
]

/** Every non-test .ts/.tsx file under src, relative to src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(name) && !/\.(?:test|spec)\.tsx?$/u.test(name) ? [relative(SRC, path)] : []
  })
}

/** `text` without its block comments (plain scanning: no backtracking regex). */
function withoutBlockComments(text: string): string {
  const start = text.indexOf('/*')
  if (start === -1) return text
  const end = text.indexOf('*/', start + 2)
  return end === -1 ? text.slice(0, start) : text.slice(0, start) + withoutBlockComments(text.slice(end + 2))
}

/** One line without a trailing `// …` comment (a URL's `://` is not one). */
function withoutLineComment(line: string): string {
  if (line.trimStart().startsWith('//')) return ''
  const at = line.indexOf(' //')
  return at === -1 ? line : line.slice(0, at)
}

/** The source without comments (a docstring may quote the banned spelling to explain it). */
function code(text: string): string {
  return withoutBlockComments(text).split('\n').map(withoutLineComment).join('\n')
}

/** "file: rule" for each rule a file breaks. */
function violationsOf(file: string): string[] {
  const text = code(readFileSync(join(SRC, file), 'utf8'))
  const exempt = file === 'utils/dateUtils.ts'
  return RULES
    .filter(([name, pattern]) => pattern.test(text) && !(exempt && name.startsWith('date-fns')))
    .map(([name]) => `${file}: ${name}`)
}

const files = sourceFiles(SRC)

describe('locale-aware formatting contract', () => {
  it('scans the real source tree (anti-vacuous)', () => {
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain('utils/dateUtils.ts')
  })

  it('no file formats a date or number in US English or the browser locale', () => {
    const violations = files.filter((file) => !(file in PENDING)).flatMap(violationsOf)
    expect(violations).toStrictEqual([])
  })

  it('catches each banned spelling (the rules are not vacuous)', () => {
    const samples = [
      "new Intl.NumberFormat('en-US')",
      'value.toLocaleString()',
      'new Intl.DateTimeFormat(undefined, options)',
      "import { format, isValid } from 'date-fns'",
    ]
    expect(samples.map((sample) => RULES.filter(([, pattern]) => pattern.test(sample)).length)).toStrictEqual([1, 1, 1, 1])
    expect(RULES.some(([, pattern]) => pattern.test('Intl.DateTimeFormat().resolvedOptions().timeZone'))).toBe(false)
  })

  it('a PENDING file still breaks a rule (remove it from the list once it is fixed)', () => {
    const stillPending = Object.keys(PENDING).filter((file) => files.includes(file) && violationsOf(file).length > 0)
    expect(stillPending).toStrictEqual(Object.keys(PENDING))
  })
})
