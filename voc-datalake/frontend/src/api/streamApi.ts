// Streaming API - extracted from client.ts to reduce file size
import { authService } from '../services/auth'
import type { FeedbackItem } from './types'
import { z } from 'zod'

const getAuthToken = async (): Promise<string | null> => {
  if (!authService.isConfigured()) return null
  try {
    return await authService.getAccessToken()
  } catch {
    return null
  }
}

// Helper to strip trailing slashes without regex backtracking
function stripTrailingSlashes(url: string): string {
  const trimmed = url.trimEnd()
  const lastNonSlash = trimmed.length - [...trimmed].reverse().findIndex(c => c !== '/')
  return trimmed.slice(0, lastNonSlash)
}

// API response parser using Zod for runtime validation
const unknownSchema = z.unknown()

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const rawJson: unknown = await response.json()
  const validated = unknownSchema.parse(rawJson)
  const typedSchema = z.custom<T>(() => true)
  return typedSchema.parse(validated)
}

async function fetchStream<T>(
  streamEndpoint: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const authToken = await getAuthToken()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }
  
  const response = await fetch(`${stripTrailingSlashes(streamEndpoint)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Stream API Error: 401 Unauthorized - Please sign in again')
    }
    throw new Error(`Stream API Error: ${response.status}`)
  }
  
  return parseJsonResponse<T>(response)
}

export interface ChatStreamResponse {
  response: string
  sources?: FeedbackItem[]
  metadata?: { total_feedback: number; days_analyzed: number; urgent_count: number }
}

export interface ProjectChatStreamResponse {
  success: boolean
  response: string
  mentioned_personas?: string[]
  selected_personas?: string[]
  referenced_documents?: string[]
  context?: { feedback_count: number; persona_count: number; document_count: number }
}

export const streamApi = {
  chatStream: (streamEndpoint: string, message: string, context?: string, days?: number) =>
    fetchStream<ChatStreamResponse>(streamEndpoint, '/chat/stream', { message, context, days: days || 7 }),
  
  projectChatStream: (
    streamEndpoint: string,
    projectId: string,
    message: string,
    selectedPersonas?: string[],
    selectedDocuments?: string[]
  ) =>
    fetchStream<ProjectChatStreamResponse>(
      streamEndpoint,
      `/projects/${projectId}/chat/stream`,
      { message, selected_personas: selectedPersonas, selected_documents: selectedDocuments }
    ),
}
