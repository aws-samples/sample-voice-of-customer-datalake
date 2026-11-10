/**
 * @fileoverview Keeps the SPA's custom-window ceiling in step with the backend.
 *
 * `MAX_CUSTOM_DAYS` is the largest lookback the picker accepts, and custom
 * windows are sent as-is (0 = all time). It must equal the backend clamp
 * (`MAX_FEEDBACK_WINDOW_DAYS`) and the stream Lambda's window cap: smaller and
 * the picker would refuse windows the API serves, larger and the request would
 * be rejected or silently clamped.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_CUSTOM_DAYS } from './baseUrl'

const LAMBDA = join(__dirname, '../../../lambda')

function constantIn(file: string, pattern: RegExp): number {
  const match = pattern.exec(readFileSync(join(LAMBDA, file), 'utf8'))
  if (match?.[1] === undefined) throw new Error(`constant not found in ${file}`)
  return Number(match[1])
}

describe('MAX_CUSTOM_DAYS', () => {
  it('is the 9999-day all-time ceiling', () => {
    expect(MAX_CUSTOM_DAYS).toBe(9999)
  })

  it('equals the backend MAX_FEEDBACK_WINDOW_DAYS', () => {
    expect(constantIn('shared/api.py', /^MAX_FEEDBACK_WINDOW_DAYS = (\d+)$/m)).toBe(MAX_CUSTOM_DAYS)
  })

  it('equals the stream Lambda window cap', () => {
    expect(constantIn('stream/src/assistant/tools/server/common.ts', /^export const MAX_WINDOW_DAYS = (\d+);$/m))
      .toBe(MAX_CUSTOM_DAYS)
  })
})
