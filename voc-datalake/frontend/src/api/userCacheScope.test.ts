/**
 * @fileoverview A second user in the same tab never sees the first user's cache:
 * the query cache is dropped when the signed-in identity leaves or changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../store/authStore'
import type { User } from '../store/authStore'
import { bindQueryCacheToUser } from './userCacheScope'

const alice: User = { username: 'alice', email: 'alice@example.com', groups: [], sub: 'sub-alice' }
const bob: User = { username: 'bob', email: 'bob@example.com', groups: [], sub: 'sub-bob' }
const KEY = ['summary', { days: 7 }] as const

const client = new QueryClient()
const cached = () => client.getQueryData(KEY) !== undefined
const binding = { unbind: () => {} }

beforeEach(() => {
  useAuthStore.getState().logout()
  useAuthStore.getState().setUser(alice)
  client.setQueryData(KEY, { total_feedback: 3 })
  binding.unbind = bindQueryCacheToUser(client)
})

afterEach(() => {
  binding.unbind()
  useAuthStore.getState().logout()
})

describe('bindQueryCacheToUser', () => {
  it('clears the cache on sign-out from any path (the store logout)', () => {
    useAuthStore.getState().logout()
    expect(cached()).toBe(false)
  })

  it('clears the cache when a different user signs in on the same tab', () => {
    useAuthStore.getState().setUser(bob)
    expect(cached()).toBe(false)
  })

  it('keeps the cache across a session refresh for the same user', () => {
    useAuthStore.getState().setUser({ ...alice, groups: ['users'] })
    useAuthStore.getState().setTokens({ accessToken: 'a', idToken: 'i', refreshToken: 'r' })
    expect(cached()).toBe(true)
  })

  it('stops watching once unbound', () => {
    binding.unbind()
    useAuthStore.getState().setUser(bob)
    expect(cached()).toBe(true)
  })
})
