/**
 * `BOARD_LIMITS` (api/boardFields.ts) against the board bounds the API enforces, read as TEXT from
 * `lambda/shared/feature_boards_store.py` / `feature_boards_audience.py` (`NAME: Final = <int>`) and
 * `feature_board_fields.py` (the status-key pattern). A bound changed on one side only fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOARD_LIMITS, STATUS_KEY } from './boardFields'

const SHARED = join(__dirname, '../../../lambda/shared')

function finalInt(file: string, name: string): number {
  const source = readFileSync(join(SHARED, file), 'utf8')
  const line = source.split('\n').find((text) => text.startsWith(`${name}: Final = `))
  if (line === undefined) throw new Error(`${name} not found in ${file}`)
  return Number(line.slice(`${name}: Final = `.length).trim())
}

describe('BOARD_LIMITS mirrors the API', () => {
  it.each([
    ['name', 'feature_boards_store.py', 'MAX_NAME'],
    ['description', 'feature_boards_store.py', 'MAX_DESCRIPTION'],
    ['slug', 'feature_boards_store.py', 'MAX_SLUG'],
    ['domains', 'feature_boards_audience.py', 'MAX_AUDIENCE_DOMAINS'],
    ['emails', 'feature_boards_audience.py', 'MAX_AUDIENCE_EMAILS'],
  ] as const)('%s = %s %s', (limit, file, name) => {
    expect(BOARD_LIMITS[limit]).toBe(finalInt(file, name))
  })

  it('statusKey is the length the status-key pattern allows', () => {
    expect([STATUS_KEY.test('a'.repeat(BOARD_LIMITS.statusKey)), STATUS_KEY.test('a'.repeat(BOARD_LIMITS.statusKey + 1))])
      .toStrictEqual([true, false])
  })
})
