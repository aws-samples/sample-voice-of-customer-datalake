/**
 * @fileoverview A Markdown file's YAML front-matter (a SKILL.md's `---` block), kept apart from its body byte for
 * byte. The canvas has no front-matter: `---\nname: fixer\n---` would read as a rule and a setext heading, and
 * touching that "heading" would rewrite it as `## name: …`. With `frontMatter: 'split'` the editor only ever sees the
 * body, and `joinFrontMatter(splitFrontMatter(x)) === x` for every text (frontMatter.test.ts runs it over every
 * template SKILL.md). The front-matter is read only in v1 (D6-5): it shows as Properties.
 *
 * @module components/Document/text/frontMatter
 */

export interface FrontMatterSplit {
  /**
   * The whole block as stored: the opening `---` line, the YAML, the closing `---` line with its line break, and the
   * blank lines after it (so the body starts at its first written line). Null: the text has none.
   */
  readonly frontMatter: string | null
  readonly body: string
}

/** A fence line: `---`, optionally followed by spaces or tabs. */
const FENCE = /^---[ \t]*$/u

/** The text's lines, each with its own line break (`\n` or `\r\n`; the last may have none). */
function linesWithBreaks(text: string): readonly string[] {
  return text.split(/(?<=\n)/u).filter((line) => line !== '')
}

const withoutBreak = (line: string): string => line.replace(/\r?\n$/u, '')

/** A front-matter block opens on the text's very first line and closes on the next fence line; else there is none. */
export function splitFrontMatter(text: string): FrontMatterSplit {
  const lines = linesWithBreaks(text)
  const [first] = lines
  if (first === undefined || !FENCE.test(withoutBreak(first)) || !first.endsWith('\n')) return { frontMatter: null, body: text }
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(withoutBreak(line)))
  if (close === -1) return { frontMatter: null, body: text }
  const blank = lines.slice(close + 1).findIndex((line) => withoutBreak(line).trim() !== '')
  const end = blank === -1 ? lines.length : close + 1 + blank
  const frontMatter = lines.slice(0, end).join('')
  return { frontMatter, body: text.slice(frontMatter.length) }
}

/** The stored text again: exactly what `splitFrontMatter` was given when neither part changed. */
export function joinFrontMatter(frontMatter: string | null, body: string): string {
  return (frontMatter ?? '') + body
}

/** The YAML between the fences (for Properties), without the fences and the blank lines after them. */
export function frontMatterYaml(frontMatter: string): string {
  const lines = linesWithBreaks(frontMatter)
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(withoutBreak(line)))
  return lines.slice(1, close === -1 ? lines.length : close).join('').replace(/\r?\n$/u, '')
}

/** A line of a flat YAML map: `key: value` on one line, the key a plain word. */
const FLAT_LINE = /^([A-Za-z0-9_.-]+):[ \t]+(\S.*)$/u
/** A value that opens a block scalar (`|`, `>`) continues on the next lines: not flat. */
const BLOCK_SCALAR = /^[|>][-+]?\d*\s*$/u

/** Every line a `key: value` (no nesting, no lists, no block scalars, no comments): the pairs, else null. */
export function flatProperties(yaml: string): readonly (readonly [string, string])[] | null {
  const lines = yaml.split(/\r?\n/u).filter((line) => line.trim() !== '')
  const pairs = lines.map((line) => FLAT_LINE.exec(line))
  if (pairs.length === 0) return null
  const flat = pairs.flatMap((match) => {
    const key = match?.[1]
    const value = match?.[2]?.trim()
    return key === undefined || value === undefined || BLOCK_SCALAR.test(value) || value.startsWith('#') ? [] : [[key, value] as const]
  })
  return flat.length === lines.length ? flat : null
}
