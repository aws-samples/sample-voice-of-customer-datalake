/**
 * Content text is at least 12px (docs/kiro-design-system.md rule 8); 10–11px is
 * only for decorative meta — uppercase section labels and mono counts/ids. The
 * design audit measured 11px content on the sidebar brand subtitle, the Connect
 * token status/scope chips, the workflow palette group labels and the loop-frame
 * label. This pins that `text-[10px]`/`text-[11px]` in app TSX only ever appear
 * with `uppercase` or `font-mono` in the same class string.
 */
import { describe, expect, it } from 'vitest'
import { appTsxLines, stringLiterals } from '@test/appSources'

/** Class-string literals on `line` that set 10/11px text without a decorative marker. */
function smallContent(line: string): string[] {
  return stringLiterals(line).filter((literal) => {
    const classes = literal.split(/\s+/)
    const small = classes.includes('text-[10px]') || classes.includes('text-[11px]')
    return small && !classes.includes('uppercase') && !classes.includes('font-mono')
  })
}

describe('minimum text size', () => {
  it('no 10/11px text outside uppercase labels and mono meta', () => {
    const offenders = appTsxLines().flatMap(({ at, line }) => smallContent(line).map((literal) => `${at} "${literal}"`))
    expect(offenders).toStrictEqual([])
  })
})
