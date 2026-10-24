/**
 * The empty conversation offers three short starters in plain words for the
 * page in view (live 5.14 review: several pages fell back to the generic set,
 * and some starters used jargon such as "scrapers" or "root cause").
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '@test/test-utils'
import EmptyState from './EmptyState'
import { PAGE_KINDS } from '../contract'
import assistantEn from '../../../public/locales/en/assistant.json'
import type { PageKind } from '../contract'

/** Page kinds that deliberately share the generic set (no data of their own to ask about). */
const GENERIC_KINDS: readonly PageKind[] = ['home', 'chat', 'other']
const DEFAULT_FIRST = assistantEn.suggestions.default['1']
const JARGON = /scraper|root cause|json|orchestrator|snake_case|\bid\b/iu

function starters(kind: PageKind): string[] {
  render(<EmptyState kind={kind} onPick={vi.fn()} />)
  return screen.getAllByRole('button').map((b) => b.textContent)
}

describe('EmptyState starters', () => {
  it.each(PAGE_KINDS.filter((kind) => !GENERIC_KINDS.includes(kind)))('%s has its own three starters', (kind) => {
    const prompts = starters(kind)
    expect(prompts).toHaveLength(3)
    expect(prompts).not.toContain(DEFAULT_FIRST)
  })

  it.each(GENERIC_KINDS)('%s uses the generic starters', (kind) => {
    expect(starters(kind)[0]).toBe(DEFAULT_FIRST)
  })

  it('keeps every English starter short and free of technical words', () => {
    const all = Object.values(assistantEn.suggestions).flatMap((group) => Object.values(group))
    expect(all.filter((prompt) => JARGON.test(prompt) || prompt.length > 70)).toStrictEqual([])
  })
})
