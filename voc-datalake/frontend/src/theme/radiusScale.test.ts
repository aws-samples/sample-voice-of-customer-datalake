/**
 * Radii come from the Kiro scale (docs/kiro-design-system.md): rounded-sm 6 ·
 * md 8 · lg 12 · xl 16 · full. The design audit measured 4px corners — Tailwind's
 * bare `rounded` — on 56 controls and chips (user-admin row actions, category
 * rows, persona chips, code samples), between the scale's steps. This pins that
 * app TSX never uses the bare class again.
 */
import { describe, expect, it } from 'vitest'
import { appTsxLines, isCommentLine, stringLiterals } from '@test/appSources'

/** True when `line` has `rounded` as a whole class token inside a string. */
function hasBareRounded(line: string): boolean {
  if (isCommentLine(line)) return false
  return stringLiterals(line).some((literal) => literal.split(/\s+/).includes('rounded'))
}

describe('radius scale', () => {
  it('no component uses the off-scale bare `rounded` (4px)', () => {
    const offenders = appTsxLines().filter(({ line }) => hasBareRounded(line)).map(({ at }) => at)
    expect(offenders).toStrictEqual([])
  })
})
