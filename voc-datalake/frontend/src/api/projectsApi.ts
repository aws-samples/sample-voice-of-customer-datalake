// Projects API - extracted from client.ts to reduce file size
import { useConfigStore } from '../store/configStore'
import { authService } from '../services/auth'
import type { Project, ProjectDetail, ProjectPersona, ProjectDocument, ProjectJob } from './types'
import { z } from 'zod'

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

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const { config } = useConfigStore.getState()
  const baseUrl = stripTrailingSlashes(config.apiEndpoint || '/api')
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ? Object.fromEntries(Object.entries(options.headers)) : {}),
  }
  
  if (authService.isConfigured()) {
    const idToken = authService.getIdToken()
    if (idToken) headers['Authorization'] = idToken
  }
  
  const response = await fetch(`${baseUrl}${endpoint}`, { ...options, headers })
  if (!response.ok) throw new Error(`API Error: ${response.status}`)
  return parseJsonResponse<T>(response)
}

export const projectsApi = {
  getProjects: () => fetchApi<{ projects: Project[] }>('/projects'),
  
  createProject: (data: { name: string; description?: string; filters?: Record<string, unknown> }) =>
    fetchApi<{ success: boolean; project: Project }>('/projects', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  getProject: (id: string) => fetchApi<ProjectDetail>(`/projects/${id}`),
  
  updateProject: (id: string, data: Partial<Project>) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  deleteProject: (id: string) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  
  generatePersonas: (projectId: string, filters?: {
    sources?: string[]
    categories?: string[]
    sentiments?: string[]
    persona_count?: number
    custom_instructions?: string
    days?: number
    response_language?: string
  }) =>
    fetchApi<{ success: boolean; personas: ProjectPersona[]; analysis?: { research: string; validation: string } }>(`/projects/${projectId}/personas/generate`, {
      method: 'POST',
      body: JSON.stringify(filters || {})
    }),
  
  createPersona: (projectId: string, persona: Omit<ProjectPersona, 'persona_id' | 'created_at'>) =>
    fetchApi<{ success: boolean; persona: ProjectPersona }>(`/projects/${projectId}/personas`, {
      method: 'POST',
      body: JSON.stringify(persona)
    }),
  
  updatePersona: (projectId: string, personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  deletePersona: (projectId: string, personaId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, { method: 'DELETE' }),
  
  importPersona: (projectId: string, data: { input_type: 'pdf' | 'image' | 'text'; content: string; media_type?: string }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/personas/import`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  runResearch: (projectId: string, data: { 
    question: string
    title?: string
    sources?: string[]
    categories?: string[]
    sentiments?: string[]
    days?: number
    selected_persona_ids?: string[]
    selected_document_ids?: string[]
    response_language?: string
  }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/research`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  generateDocument: (projectId: string, data: {
    doc_type: 'prd' | 'prfaq'
    title: string
    feature_idea: string
    data_sources: { feedback: boolean; personas: boolean; documents: boolean; research: boolean }
    selected_persona_ids: string[]
    selected_document_ids: string[]
    feedback_sources: string[]
    feedback_categories: string[]
    days: number
    customer_questions?: string[]
    response_language?: string
  }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/document`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  mergeDocuments: (projectId: string, data: {
    output_type: 'prd' | 'prfaq' | 'custom'
    title: string
    instructions: string
    selected_document_ids: string[]
    selected_persona_ids?: string[]
    use_feedback?: boolean
    feedback_sources?: string[]
    feedback_categories?: string[]
    days?: number
    response_language?: string
  }) =>
    fetchApi<{ success: boolean; job_id: string; status: string; message: string }>(`/projects/${projectId}/documents/merge`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  getJobStatus: (projectId: string, jobId: string) =>
    fetchApi<ProjectJob>(`/projects/${projectId}/jobs/${jobId}`),
  
  getJobs: (projectId: string) =>
    fetchApi<{ success: boolean; jobs: ProjectJob[] }>(`/projects/${projectId}/jobs`),
  
  dismissJob: (projectId: string, jobId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/jobs/${jobId}`, { method: 'DELETE' }),
  
  createDocument: (projectId: string, data: { title: string; content: string; document_type?: string }) =>
    fetchApi<{ success: boolean; document: ProjectDocument }>(`/projects/${projectId}/documents`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  
  updateDocument: (projectId: string, documentId: string, data: { title?: string; content?: string }) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),
  
  deleteDocument: (projectId: string, documentId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, { method: 'DELETE' }),

  getAutoseed: (projectId: string, personaIds?: string[], documentIds?: string[]) => {
    const params = new URLSearchParams()
    if (personaIds?.length) params.set('persona_ids', personaIds.join(','))
    if (documentIds?.length) params.set('document_ids', documentIds.join(','))
    const qs = params.toString()
    const endpoint = `/projects/${projectId}/autoseed`
    return fetchApi<{ project: { name: string; description: string }; files: { path: string; content: string }[] }>(
      qs ? `${endpoint}?${qs}` : endpoint
    )
  },
}
