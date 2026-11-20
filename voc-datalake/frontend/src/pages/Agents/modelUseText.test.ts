/**
 * @fileoverview A model's use on one line (modelUseText.ts, 7.58.00): a native model's tokens in and out; a Kiro
 * session's model its credits and what they cost at the deployment's price per credit.
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useModelUseText } from './modelUseText'

describe('a model\'s use on the run page', () => {
  it('says a native model\'s tokens, and a Kiro session\'s credits with their cost', () => {
    const { result } = renderHook(() => useModelUseText())
    const text = result.current
    expect(text({ model: 'global.anthropic.claude-sonnet-5-5', input_tokens: 1200, output_tokens: 80, credits: null, credits_usd: null }))
      .toBe('global.anthropic.claude-sonnet-5-5: 1,200 in, 80 out')
    expect(text({ model: 'kiro:claude-haiku-5.5', input_tokens: 0, output_tokens: 0, credits: 3, credits_usd: 0.12 }))
      .toBe('kiro:claude-haiku-5.5: 3 Kiro credits ($0.12)')
    expect(text({ model: '', input_tokens: 1, output_tokens: 2, credits: null, credits_usd: null })).toBe('—: 1 in, 2 out')
  })
})
