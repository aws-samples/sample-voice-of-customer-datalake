// Streaming API with AWS IAM authentication
import { fetchAuthSession } from 'aws-amplify/auth'
import { SignatureV4 } from '@aws-sdk/signature-v4'
import { HttpRequest } from '@aws-sdk/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import { getConfig } from '../config'
import { parseJsonResponse } from './client'
import type { FeedbackItem } from './types'

function stripTrailingSlashes(url: string): string {
  const trimmed = url.trimEnd()
  const lastNonSlash = trimmed.length - [...trimmed].reverse().findIndex(c => c !== '/')
  return trimmed.slice(0, lastNonSlash)
}

async function fetchStream<T>(
  streamEndpoint: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const url = `${stripTrailingSlashes(streamEndpoint)}${path}`
  
  try {
    const session = await fetchAuthSession()
    
    if (!session.credentials) {
      throw new Error('Not authenticated - please sign in')
    }

    const cfg = getConfig()
    const urlObj = new URL(url)
    const bodyStr = JSON.stringify(body)

    const request = new HttpRequest({
      method: 'POST',
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'Content-Type': 'application/json',
        host: urlObj.hostname,
      },
      body: bodyStr,
    })

    const signer = new SignatureV4({
      credentials: {
        accessKeyId: session.credentials.accessKeyId,
        secretAccessKey: session.credentials.secretAccessKey,
        sessionToken: session.credentials.sessionToken,
      },
      region: cfg.cognito.region,
      service: 'lambda',
      sha256: Sha256,
    })

    const signedRequest = await signer.sign(request)

    const response = await fetch(url, {
      method: signedRequest.method,
      headers: signedRequest.headers,
      body: bodyStr,
    })

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Stream API Error: 403 Forbidden - Please sign in again')
      }
      if (response.status === 401) {
        throw new Error('Stream API Error: 401 Unauthorized - Session expired')
      }
      throw new Error(`Stream API Error: ${response.status}`)
    }

    return parseJsonResponse<T>(response)
    
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('No credentials')) {
        throw new Error('Authentication required - please sign in')
      }
      if (error.message.includes('expired')) {
        throw new Error('Session expired - please sign in again')
      }
    }
    throw error
  }
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
