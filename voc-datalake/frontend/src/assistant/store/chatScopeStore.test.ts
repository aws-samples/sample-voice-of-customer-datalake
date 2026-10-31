/**
 * The /chat filter panel's scope on the wire: per conversation, empty values dropped, sent as
 * `forwardedProps.scope` from the chat page only, and never sent when the contract would refuse it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { buildForwardedProps } from '../agui/forwardedProps'
import { chatScopeFor, useChatScopeStore } from './chatScopeStore'
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

  it('falls back to an empty scope (the cap only) when the filters would be refused', () => {
    useChatScopeStore.getState().setFilters('a', { tag: 'x'.repeat(MAX_PAGE_FILTER_CHARS + 1) })
    expect(chatScopeFor('a')).toStrictEqual({})
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

  it('leaves out a scope the stream would refuse', () => {
    expect(scopeSent(CHAT, { limit: CHAT_SCOPE_MAX_ITEMS + 1 })).toBeUndefined()
  })
})
