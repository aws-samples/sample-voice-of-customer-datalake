/**
 * A visually hidden file input that a visible button opens is not a Tab stop
 * of its own (design audit D-KBD): on Company → Design the logo input took an
 * invisible stop right before its "Upload logo" button. Every `sr-only` file
 * input in app TSX carries tabIndex={-1} unless it is the only control (a
 * label-wrapped dropzone keeps it focusable on purpose and says so with
 * `data-focus-target`).
 */
import { describe, expect, it } from 'vitest'
import { appTsxLines } from '@test/appSources'

describe('tab stops', () => {
  it('sr-only file inputs opened by a button are not their own Tab stop', () => {
    const offenders = appTsxLines()
      .filter(({ line }) => line.includes('type="file"') && line.includes('sr-only'))
      .filter(({ line }) => !line.includes('tabIndex={-1}') && !line.includes('data-focus-target'))
      .map(({ at }) => at)
    expect(offenders).toStrictEqual([])
  })
})
