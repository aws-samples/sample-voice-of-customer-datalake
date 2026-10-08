/**
 * Icons come from lucide-react (docs/kiro-design-system.md rule 4). The design
 * audit found Unicode glyphs drawn as icons — ✓ on the document-type tiles,
 * ★ ratings on Problem Analysis and in the JSON upload preview — which render
 * in whatever font has the glyph, ignore the icon sizes, and read out as
 * "check mark" / "black star" instead of the rating. This pins that no app UI
 * source puts one in rendered output again (comments are fine).
 */
import { describe, expect, it } from 'vitest'
import { appTsxLines, isCommentLine } from '@test/appSources'

const GLYPHS = ['✓', '✔', '✗', '✘', '★', '☆', '⚠']

describe('icon glyphs', () => {
  it('no component renders a Unicode check/star/warning glyph instead of a lucide icon', () => {
    const offenders = appTsxLines()
      .filter(({ line }) => !isCommentLine(line) && GLYPHS.some((glyph) => line.includes(glyph)))
      .map(({ at, line }) => `${at} ${line.trim().slice(0, 80)}`)
    expect(offenders).toStrictEqual([])
  })
})
