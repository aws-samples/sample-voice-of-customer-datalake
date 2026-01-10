// Artifact Builder API - extracted from client.ts to reduce file size
import { useConfigStore } from '../store/configStore'
import { authService } from '../services/auth'
import type { ArtifactJob, ArtifactTemplate, ArtifactStyle } from './types'
import { z } from 'zod'

const getArtifactBuilderUrl = () => {
  const { config } = useConfigStore.getState()
  return config.artifactBuilderEndpoint || ''
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

async function fetchArtifactApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseUrl = stripTrailingSlashes(getArtifactBuilderUrl())
  
  if (!baseUrl) {
    throw new Error('Artifact Builder endpoint not configured')
  }
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ? Object.fromEntries(Object.entries(options.headers)) : {}),
  }
  
  if (authService.isConfigured()) {
    const idToken = authService.getIdToken()
    if (idToken) {
      headers['Authorization'] = idToken
    }
  }
  
  const response = await fetch(`${baseUrl}${endpoint}`, { ...options, headers })
  
  if (!response.ok) {
    throw new Error(`Artifact Builder API Error: ${response.status}`)
  }
  
  return parseJsonResponse<T>(response)
}

export const artifactApi = {
  getTemplates: () => 
    fetchArtifactApi<{ templates: ArtifactTemplate[]; styles: ArtifactStyle[] }>('/templates'),
  
  createJob: (data: { prompt: string; project_type: string; style: string; include_mock_data?: boolean; pages?: string[]; parent_job_id?: string }) =>
    fetchArtifactApi<{ job_id: string; parent_job_id?: string }>('/jobs', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  getJobs: (status?: string) => {
    const params = status ? `?status=${status}` : ''
    return fetchArtifactApi<{ jobs: ArtifactJob[] }>(`/jobs${params}`)
  },
  
  getJob: (jobId: string) => 
    fetchArtifactApi<ArtifactJob>(`/jobs/${jobId}`),
  
  getJobLogs: (jobId: string) =>
    fetchArtifactApi<{ logs: string }>(`/jobs/${jobId}/logs`),
  
  getDownloadUrl: (jobId: string) =>
    fetchArtifactApi<{ download_url: string }>(`/jobs/${jobId}/download`),
  
  deleteJob: (jobId: string) =>
    fetchArtifactApi<{ success: boolean; message: string }>(`/jobs/${jobId}`, { method: 'DELETE' }),
  
  getSourceFiles: (jobId: string, path?: string) => {
    const params = path ? `?path=${encodeURIComponent(path)}` : ''
    return fetchArtifactApi<{ files: Array<{ path: string; type: 'file' | 'folder' }> }>(`/jobs/${jobId}/source${params}`)
  },
  
  getSourceFileContent: (jobId: string, filePath: string) =>
    fetchArtifactApi<{ content: string; path: string }>(`/jobs/${jobId}/source/file?path=${encodeURIComponent(filePath)}`),
}
