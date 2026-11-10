/**
 * The Radar numbers the SPA states in words, against the backend that decides them, read as TEXT: the compare
 * threshold (`MIN_COMPARE_REVIEWS`, shared/radar_views.py; the footnote says "at least N of their reviews" and an
 * older API's rows are judged with it) and the page's release cap (`MAX_RELEASES`, api/radar_handler.py; the
 * releases tile says "at least N" at the cap). The dev mock's copy of the threshold follows too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RADAR_COMPARE_MIN_REVIEWS, RADAR_PAGE_RELEASES_CAP } from './radarSchema'

const LAMBDA = join(__dirname, '../../../lambda')

/** The integer of `NAME: Final = <n>` (Python) or `const NAME = <n>;` (the mock) in `file`. */
function constant(file: string, name: string): number {
  const source = readFileSync(file, 'utf8')
  const match = new RegExp(`^(?:const )?${name}(?:: Final)? = (\\d+);?\\s*$`, 'm').exec(source)
  if (match?.[1] === undefined) throw new Error(`${name} not found in ${file}`)
  return Number(match[1])
}

describe('Radar numbers the SPA states', () => {
  it('uses the backend compare threshold, as the dev mock does', () => {
    expect([
      constant(join(LAMBDA, 'shared/radar_views.py'), 'MIN_COMPARE_REVIEWS'),
      constant(join(__dirname, '../../mock-radar.js'), 'COMPARE_MIN_REVIEWS'),
    ]).toStrictEqual([RADAR_COMPARE_MIN_REVIEWS, RADAR_COMPARE_MIN_REVIEWS])
  })

  it("uses the backend's cap on a page's releases", () => {
    expect(constant(join(LAMBDA, 'api/radar_handler.py'), 'MAX_RELEASES')).toBe(RADAR_PAGE_RELEASES_CAP)
  })
})
