/**
 * Just enough Markdown reading for the PR description check: what a reader SEES, split into sections.
 *
 * Why it exists: a pull request template guides its author with HTML comments and examples in code
 * fences. A check that read the raw body would accept a heading or a `Proof:` line that only sits inside
 * the template's own guidance. This module blanks every line inside a fenced code block and every
 * character inside an HTML comment, then splits the remaining lines at ATX headings of level 1 or 2.
 *
 * Limits: this is not a CommonMark parser. It knows backtick and tilde fences (a fence closes with the
 * same character, at least as long, as CommonMark says: https://spec.commonmark.org/0.31.2/#fenced-code-blocks)
 * and `<!-- -->` comments, including multi-line ones. It ignores indented code blocks, setext headings
 * and HTML blocks other than comments. Line endings are normalised first, so CRLF bodies read the same.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/

/** The body with `\r\n` and lone `\r` turned into `\n`. */
export function normaliseNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n')
}

/** Remove the parts of one line that sit inside an HTML comment; returns the visible text and the new state. */
function stripComments(line, inComment) {
  let visible = ''
  let rest = line
  let open = inComment
  while (rest.length > 0) {
    if (open) {
      const end = rest.indexOf('-->')
      if (end === -1) return { visible, inComment: true }
      rest = rest.slice(end + 3)
      open = false
    } else {
      const start = rest.indexOf('<!--')
      if (start === -1) return { visible: visible + rest, inComment: false }
      visible += rest.slice(0, start)
      rest = rest.slice(start + 4)
      open = true
    }
  }
  return { visible, inComment: open }
}

/** Does `line` close the fence opened by `opener` (e.g. "```")? */
function closesFence(line, opener) {
  const match = FENCE.exec(line)
  if (match === null) return false
  const marker = match[1]
  return marker[0] === opener[0] && marker.length >= opener.length && line.slice(match[0].length).trim() === ''
}

/**
 * The lines a reader sees, one per input line (so line numbers still match): fenced code and comment
 * text become ''. Fence lines themselves are blanked too.
 */
export function visibleLines(body) {
  const out = []
  let inComment = false
  let fence = null
  for (const line of normaliseNewlines(body).split('\n')) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      out.push('')
      continue
    }
    const stripped = stripComments(line, inComment)
    inComment = stripped.inComment
    const match = FENCE.exec(stripped.visible)
    if (match !== null && stripped.visible === line) {
      fence = match[1]
      out.push('')
      continue
    }
    out.push(stripped.visible)
  }
  return out
}

/** `{level, text}` when a visible line is an ATX heading, else null. */
export function parseHeading(line) {
  const match = HEADING.exec(line)
  if (match === null) return null
  // An optional closing sequence (`## Tests ##`) is not part of the text.
  const text = (match[2] ?? '').trim().replace(/(?:^|[ \t])#+$/, '').trim()
  return { level: match[1].length, text }
}

/**
 * Sections split at visible headings of level 1 or 2. Each is `{heading, level, lines}` where `lines`
 * are the visible lines up to the next level-1/2 heading (level-3+ headings stay inside). Text before
 * the first heading is the section with heading ''.
 */
export function sections(body) {
  const result = [{ heading: '', level: 0, lines: [] }]
  for (const line of visibleLines(body)) {
    const heading = parseHeading(line)
    if (heading !== null && heading.level <= 2) {
      result.push({ heading: heading.text, level: heading.level, lines: [] })
    } else {
      result[result.length - 1].lines.push(line)
    }
  }
  return result
}

/** The first section whose heading starts with `prefix`, compared case-insensitively; null when absent. */
export function findSection(all, prefix) {
  const wanted = prefix.toLowerCase()
  return all.find((section) => section.heading.toLowerCase().startsWith(wanted)) ?? null
}

/** Non-blank visible lines of a section, trimmed. */
export function contentLines(section) {
  return section === null ? [] : section.lines.map((line) => line.trim()).filter((line) => line !== '')
}

/** A line without a leading list marker (`-`, `*`, `+`, `1.`) and without surrounding `**` bold markers on a label. */
export function plainLine(line) {
  return line
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\*\*([^*]+?):\*\*/, '$1:')
    .replace(/^\*\*([^*]+?)\*\*:/, '$1:')
    .trim()
}
