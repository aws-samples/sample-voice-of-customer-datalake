/**
 * Ways of working with AI (docs/ways-of-working.md): the lenient read of `ai_mode` (default
 * AI-driven) and the rule the editor shapes itself by — 3 modes × PR/FAQ / PRD / other types,
 * with the Human-driven unlocks. The server (`lambda/shared/ai_writing.py`) enforces the same
 * rule; the SPA only mirrors it.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_AI_MODE, aiMayWrite, isGatedDocType, readAiMode } from './aiModeApi'
import type { AiMode, AiModeName } from './aiModeApi'

const mode = (name: AiModeName, unlocks: Partial<Pick<AiMode, 'ai_writing_prfaq' | 'ai_writing_prd'>> = {}): AiMode => ({
  mode: name, ai_writing_prfaq: false, ai_writing_prd: false, ...unlocks,
})

describe('readAiMode', () => {
  it('reads the ai_mode block of a users row or a /users/me/ai-mode answer', () => {
    expect(readAiMode({ username: 'vic', ai_mode: { mode: 'human_driven', ai_writing_prfaq: true, ai_writing_prd: false } }))
      .toStrictEqual({ mode: 'human_driven', ai_writing_prfaq: true, ai_writing_prd: false })
  })

  it('reads a row without the block (no stored mode, or an older API) as AI-driven', () => {
    expect([readAiMode({ username: 'vic' }), readAiMode(null), readAiMode('nope')])
      .toStrictEqual([DEFAULT_AI_MODE, DEFAULT_AI_MODE, DEFAULT_AI_MODE])
  })

  it('reads an unknown mode as AI-driven and an unreadable unlock as locked', () => {
    expect(readAiMode({ ai_mode: { mode: 'robot', ai_writing_prfaq: 'yes' } })).toStrictEqual(DEFAULT_AI_MODE)
  })
})

describe('aiMayWrite', () => {
  it.each([
    ['ai_driven', 'prfaq', true], ['ai_driven', 'prd', true], ['ai_driven', 'custom', true],
    ['ai_assisted', 'prfaq', true], ['ai_assisted', 'prd', true], ['ai_assisted', 'custom', true],
    ['human_driven', 'prfaq', false], ['human_driven', 'prd', false], ['human_driven', 'custom', true],
  ] as const)('%s on %s → %s', (name, docType, allowed) => {
    expect(aiMayWrite(mode(name), docType)).toBe(allowed)
  })

  it('lets a Human-driven person write the one type an admin unlocked, only that one', () => {
    const prfaqOnly = mode('human_driven', { ai_writing_prfaq: true })
    const prdOnly = mode('human_driven', { ai_writing_prd: true })
    expect([aiMayWrite(prfaqOnly, 'prfaq'), aiMayWrite(prfaqOnly, 'prd'), aiMayWrite(prdOnly, 'prd'), aiMayWrite(prdOnly, 'prfaq')])
      .toStrictEqual([true, false, true, false])
  })

  it('ignores the unlocks outside Human-driven', () => {
    expect(aiMayWrite(mode('ai_assisted', { ai_writing_prfaq: false }), 'prfaq')).toBe(true)
  })

  it('lets the AI write when the document type is unknown', () => {
    expect([aiMayWrite(mode('human_driven'), undefined), aiMayWrite(mode('human_driven'), 'research')]).toStrictEqual([true, true])
  })
})

describe('isGatedDocType', () => {
  it('names PR/FAQ and PRD only', () => {
    expect(['prfaq', 'prd', 'custom', 'PRFAQ', null].map(isGatedDocType)).toStrictEqual([true, true, false, false, false])
  })
})
