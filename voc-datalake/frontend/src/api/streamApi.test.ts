/**
 * @fileoverview Tests for streamApi.ts
 * @module api/streamApi.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock auth service before importing
vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
  },
}))

import { streamApi } from './streamApi'
import { authService } from '../services/auth'

describe('streamApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('chatStream', () => {
    it('sends chat message with auth token', async () => {
      const mockResponse = {
        response: 'AI response text',
        sources: [{ feedback_id: 'fb-1' }],
        metadata: { total_feedback: 100, days_analyzed: 7, urgent_count: 5 },
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await streamApi.chatStream(
        'https://stream.example.com',
        'What do customers think?',
        'context info',
        7
      )

      expect(result).toEqual(mockResponse)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://stream.example.com/chat/stream',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer mock-access-token',
          },
          body: JSON.stringify({
            message: 'What do customers think?',
            context: 'context info',
            days: 7,
          }),
        })
      )
    })

    it('uses default days when not provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'test' }),
      })

      await streamApi.chatStream('https://stream.example.com', 'Hello')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            message: 'Hello',
            context: undefined,
            days: 7,
          }),
        })
      )
    })

    it('throws error on 401 unauthorized', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
      })

      await expect(
        streamApi.chatStream('https://stream.example.com', 'test')
      ).rejects.toThrow('Stream API Error: 401 Unauthorized - Please sign in again')
    })

    it('throws error on other non-ok responses', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(
        streamApi.chatStream('https://stream.example.com', 'test')
      ).rejects.toThrow('Stream API Error: 500')
    })

    it('works without auth when not configured', async () => {
      vi.mocked(authService.isConfigured).mockReturnValue(false)
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'test' }),
      })

      await streamApi.chatStream('https://stream.example.com', 'test')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    it('handles auth token retrieval failure gracefully', async () => {
      vi.mocked(authService.getAccessToken).mockRejectedValueOnce(new Error('Token expired'))
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'test' }),
      })

      await streamApi.chatStream('https://stream.example.com', 'test')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })
  })

  describe('projectChatStream', () => {
    it('sends project chat with personas and documents', async () => {
      const mockResponse = {
        success: true,
        response: 'Project-specific response',
        mentioned_personas: ['persona-1'],
        selected_personas: ['persona-1', 'persona-2'],
        referenced_documents: ['doc-1'],
        context: { feedback_count: 50, persona_count: 3, document_count: 2 },
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await streamApi.projectChatStream(
        'https://stream.example.com',
        'project-123',
        'What are the main pain points?',
        ['persona-1', 'persona-2'],
        ['doc-1']
      )

      expect(result).toEqual(mockResponse)
      expect(global.fetch).toHaveBeenCalledWith(
        'https://stream.example.com/projects/project-123/chat/stream',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            message: 'What are the main pain points?',
            selected_personas: ['persona-1', 'persona-2'],
            selected_documents: ['doc-1'],
          }),
        })
      )
    })

    it('sends project chat without optional parameters', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, response: 'test' }),
      })

      await streamApi.projectChatStream(
        'https://stream.example.com',
        'project-123',
        'General question'
      )

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            message: 'General question',
            selected_personas: undefined,
            selected_documents: undefined,
          }),
        })
      )
    })
  })

  describe('stripTrailingSlashes', () => {
    it('strips trailing slashes from stream endpoint', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ response: 'test' }),
      })

      await streamApi.chatStream('https://stream.example.com///', 'test')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://stream.example.com/chat/stream',
        expect.any(Object)
      )
    })
  })
})
