import { describe, it, expect } from 'vitest'
import { isChatRoute } from './chatRoute'

describe('isChatRoute', () => {
  it('matches the chat page itself', () => {
    expect(isChatRoute('/chat')).toBe(true)
  })

  it('matches a path below the chat page', () => {
    expect(isChatRoute('/chat/conv-1')).toBe(true)
  })

  it('does not match a path that only ends in /chat/', () => {
    expect(isChatRoute('/projects/chat/')).toBe(false)
  })

  it('does not match a path that merely starts with the letters chat', () => {
    expect(isChatRoute('/chatter')).toBe(false)
  })
})
