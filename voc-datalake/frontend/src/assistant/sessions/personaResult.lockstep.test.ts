/**
 * LOCKSTEP: the SPA and the stream Lambda save the same session, so a persona-cards result must
 * be stored identically by both (`./personaResult.ts`, `lambda/stream/src/assistant/session/
 * persona-result.ts`). Every shared input is run through both; the caps must match too.
 */
import { describe, expect, it } from 'vitest'
import * as server from '../../../../lambda/stream/src/assistant/session/persona-result'
import { PERSONA_RESULT_LOCKSTEP_INPUTS, SIX_LONG_ANSWERS } from '../../../../lambda/stream/src/assistant/session/persona-result-fixtures'
import { MAX_RETRY_PERSONA_CHARS, MAX_STORED_PERSONA_CHARS, storedPersonaResult } from './personaResult'

describe('persona result storage lockstep', () => {
  it('uses the same caps as the stream Lambda', () => {
    expect({ stored: MAX_STORED_PERSONA_CHARS, retry: MAX_RETRY_PERSONA_CHARS })
      .toStrictEqual({ stored: server.MAX_STORED_PERSONA_CHARS, retry: server.MAX_RETRY_PERSONA_CHARS })
  })

  it.each(PERSONA_RESULT_LOCKSTEP_INPUTS.map((input, index) => ({ ...input, index })))(
    'stores input $index (budget $budget) like the stream Lambda',
    ({ text, budget }) => {
      expect(storedPersonaResult(text, budget)).toBe(server.storedPersonaResult(text, budget))
    },
  )

  it('keeps a long round readable in the saved session (positive control)', () => {
    const stored = storedPersonaResult(SIX_LONG_ANSWERS, 6000) ?? ''
    expect((): unknown => JSON.parse(stored)).not.toThrow()
  })
})
