/**
 * The /chat filter panel's scope on the wire: per conversation, empty values dropped, sent as
 * `forwardedProps.scope` from the chat page only, and never sent when the contract would refuse it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildForwardedProps } from '../agui/forwardedProps'
import { REFUSED_SCOPE, chatScopeFor, useChatScopeStore } from './chatScopeStore'
import { CHAT_SCOPE_MAX_ITEMS, MAX_PAGE_FILTER_CHARS } from '../contract'
import type { ChatScope, PageContext } from '../contract'

const CHAT: PageContext = { kind: 'chat', path: '/chat' }

function scopeSent(page: PageContext, scope: ChatScope | undefined) {
  return buildForwardedProps({ page, language: 'en', useWebSearch: false, scope }).scope
}

beforeEach(() => {
  useChatScopeStore.setState({ byThread: {} })
})

describe('chatScopeStore', () => {
  it('keeps one scope per conversation and drops cleared fields', () => {
    useChatScopeStore.getState().setFilters('a', { source: 'webscraper', tag: '  ', urgent: '' })
    expect(chatScopeFor('a')).toStrictEqual({ filters: { source: 'webscraper' } })
    expect(chatScopeFor('b')).toStrictEqual({})
  })

  it('cuts an overlong value to the bound instead of dropping the floor', () => {
    useChatScopeStore.getState().setFilters('a', { tag: 'x'.repeat(MAX_PAGE_FILTER_CHARS + 1) })
    expect(chatScopeFor('a')).toStrictEqual({ filters: { tag: 'x'.repeat(MAX_PAGE_FILTER_CHARS) } })
  })

  it('carries a full 50-value category list whole', () => {
    const categories = Array.from({ length: 50 }, (_, n) => `${'c'.repeat(125)}${String(n).padStart(3, '0')}`).join(',')
    useChatScopeStore.getState().setFilters('a', { category: categories })
    expect(chatScopeFor('a')).toStrictEqual({ filters: { category: categories } })
  })
})

describe('forwardedProps.scope', () => {
  it('carries the scope from the chat page, an empty one included', () => {
    expect(scopeSent(CHAT, { filters: { category: 'delivery,billing' } })).toStrictEqual({ filters: { category: 'delivery,billing' } })
    expect(scopeSent(CHAT, {})).toStrictEqual({})
  })

  it('leaves it out on any other page, whose own page.filters are the floor', () => {
    expect(scopeSent({ kind: 'categories', path: '/categories', filters: { category: 'delivery' } }, { filters: { source: 'x' } }))
      .toBeUndefined()
  })

  it('sends a scope that admits nothing in place of one the stream would refuse (never no floor)', () => {
    expect(scopeSent(CHAT, { limit: CHAT_SCOPE_MAX_ITEMS + 1 })).toStrictEqual(REFUSED_SCOPE)
  })
})
