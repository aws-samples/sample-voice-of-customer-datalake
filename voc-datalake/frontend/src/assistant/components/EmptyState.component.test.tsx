/**
 * The empty conversation offers three short starters in plain words for the
 * page in view (live 5.14 review: several pages fell back to the generic set,
 * and some starters used jargon such as "scrapers" or "root cause").
 */
import { describe, it, expect, vi, onTestFinished } from 'vitest'
import { act, screen } from '@testing-library/react'
import { render } from '@test/test-utils'
import EmptyState from './EmptyState'
import { PAGE_KINDS } from '../contract'
import assistantEn from '../../../public/locales/en/assistant.json'
import { useThemeStore } from '../../theme/themeStore'
import { WORKSPACE_THEME_CHOICE } from '../../theme/themeCatalog'
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

describe('EmptyState mark', () => {
  it('greets with the active theme\'s idle mark, keeping its size and colour', () => {
    const { container } = render(<EmptyState kind="home" onPick={vi.fn()} />)
    const mark = () => container.querySelector('section > svg')
    expect(mark()).toHaveAttribute('data-mark', 'kiro')
    onTestFinished(() => { act(() => { useThemeStore.setState({ colorTheme: WORKSPACE_THEME_CHOICE }) }) })
    act(() => { useThemeStore.setState({ colorTheme: 'highcontrast' }) })
    expect(mark()).toHaveAttribute('data-mark', 'highcontrast')
    expect(mark()).toHaveClass('h-14', 'w-14', 'text-aim')
  })
})
