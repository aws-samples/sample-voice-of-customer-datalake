/**
 * Ways of working with AI (docs/ways-of-working.md): the lenient read of `ai_mode` (default
 * AI-driven) and the rule the editor shapes itself by — 3 modes × PR/FAQ / PRD / other types,
 * with the Human-driven unlocks. The server (`lambda/shared/ai_writing.py`) enforces the same
 * rule; the SPA only mirrors it.
 */
import { describe, it, expect, vi } from 'vitest'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('./client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { DEFAULT_AI_MODE, aiMayWrite, aiModeApi, isGatedDocType, readAiMode, readStoredAiMode } = await import('./aiModeApi')
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

describe('readStoredAiMode', () => {
  const human = { mode: 'human_driven', ai_writing_prfaq: false, ai_writing_prd: true }

  it('reads whether a mode is saved (7.50.02)', () => {
    expect(readStoredAiMode({ ai_mode: { ...human, saved: true } }))
      .toStrictEqual({ mode: 'human_driven', ai_writing_prfaq: false, ai_writing_prd: true, saved: true })
    expect(readStoredAiMode({ ai_mode: { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false, saved: false } }))
      .toStrictEqual({ ...DEFAULT_AI_MODE, saved: false })
  })

  it('counts a mode named without `saved` (an older answer) as saved, and an unreadable one as not', () => {
    expect(readStoredAiMode({ ai_mode: human }).saved).toBe(true)
    expect(readStoredAiMode({ ai_mode: { ...human, saved: 'yes' } }).saved).toBe(true)
    expect(readStoredAiMode({ ai_mode: { mode: 'robot', saved: true } })).toStrictEqual({ ...DEFAULT_AI_MODE, saved: false })
  })

  it('reads no block as nothing saved', () => {
    expect([readStoredAiMode({ username: 'vic' }), readStoredAiMode(null)])
      .toStrictEqual([{ ...DEFAULT_AI_MODE, saved: false }, { ...DEFAULT_AI_MODE, saved: false }])
  })

  it('leaves readAiMode as it was: no saved field, the documents\' default for nothing saved', () => {
    expect(readAiMode({ ai_mode: { ...human, saved: true } })).toStrictEqual(human)
    expect(readAiMode({ ai_mode: { mode: 'ai_driven', saved: false } })).toStrictEqual(DEFAULT_AI_MODE)
  })
})

describe('aiModeApi.saveMine', () => {
  it('PUTs the caller\'s own mode to /users/me/ai-mode and reads the stored answer', async () => {
    fetchApi.mockResolvedValueOnce({ success: true, ai_mode: { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false, saved: true } })

    const saved = await aiModeApi.saveMine('ai_driven')

    expect(fetchApi.mock.calls).toStrictEqual([['/users/me/ai-mode', { method: 'PUT', body: '{"ai_mode":"ai_driven"}' }]])
    expect(saved).toStrictEqual({ mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false, saved: true })
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
