/**
 * @fileoverview Tests for streamApi.ts
 * @module api/streamApi.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Amplify auth
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(() =>
    Promise.resolve({
      credentials: {
        accessKeyId: 'mock-access-key',
        secretAccessKey: 'mock-secret-key',
        sessionToken: 'mock-session-token',
      },
    })
  ),
}))

// Mock SignatureV4
const mockSign = vi.fn()

vi.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: class MockSignatureV4 {
    sign = mockSign
  },
}))

// Mock config
vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({
    cognito: {
      region: 'us-east-1',
      userPoolId: 'us-east-1_test',
      userPoolClientId: 'test-client-id',
    },
    apiEndpoint: 'https://api.example.com',
    streamEndpoint: 'https://stream.example.com',
  })),
}))

import { streamApi } from './streamApi'
import { fetchAuthSession } from 'aws-amplify/auth'

describe('streamApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
    mockSign.mockImplementation((request) =>
      Promise.resolve({
        ...request,
        headers: {
          ...request.headers,
          Authorization: 'AWS4-HMAC-SHA256 mock-signature',
          'X-Amz-Date': '20260211T120000Z',
        },
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('chatStream', () => {
    it('sends chat message with SigV4 signature', async () => {
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
      expect(fetchAuthSession).toHaveBeenCalled()
      expect(global.fetch).toHaveBeenCalledWith(
        'https://stream.example.com/chat/stream',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
          }),
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
      ).rejects.toThrow('Session expired - please sign in again')
    })

    it('throws error on 403 forbidden', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 403,
      })

      await expect(
        streamApi.chatStream('https://stream.example.com', 'test')
      ).rejects.toThrow('Stream API Error: 403 Forbidden - Please sign in again')
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
