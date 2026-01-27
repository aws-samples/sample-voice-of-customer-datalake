/**
 * @fileoverview Tests for Projects API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock stores and auth before importing
vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => ({
      config: { apiEndpoint: 'https://api.example.com' },
    })),
  },
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-id-token'),
  },
}))

import { projectsApi } from './projectsApi'

describe('projectsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getProjects', () => {
    it('fetches projects list', async () => {
      const mockProjects = { projects: [{ project_id: 'p1', name: 'Project 1' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockProjects),
      })

      const result = await projectsApi.getProjects()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'mock-id-token',
          }),
        })
      )
      expect(result).toEqual(mockProjects)
    })
  })

  describe('createProject', () => {
    it('sends POST request with project data', async () => {
      const projectData = { name: 'New Project', description: 'Test description' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, project: { ...projectData, project_id: 'p1' } }),
      })

      await projectsApi.createProject(projectData)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(projectData),
        })
      )
    })

    it('includes filters when provided', async () => {
      const projectData = { name: 'Project', filters: { sources: ['twitter'] } }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, project: { ...projectData, project_id: 'p1' } }),
      })

      await projectsApi.createProject(projectData)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects',
        expect.objectContaining({
          body: JSON.stringify(projectData),
        })
      )
    })
  })

  describe('getProject', () => {
    it('fetches single project by ID', async () => {
      const mockProject = { project_id: 'p1', name: 'Project 1', personas: [], documents: [] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockProject),
      })

      const result = await projectsApi.getProject('p1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1',
        expect.any(Object)
      )
      expect(result).toEqual(mockProject)
    })
  })

  describe('updateProject', () => {
    it('sends PUT request with project updates', async () => {
      const updates = { name: 'Updated Name', description: 'New description' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.updateProject('p1', updates)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(updates),
        })
      )
    })
  })

  describe('deleteProject', () => {
    it('sends DELETE request for project', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.deleteProject('p1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('generatePersonas', () => {
    it('sends POST request to generate personas', async () => {
      const mockResponse = { success: true, personas: [{ persona_id: 'per1', name: 'Power User' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await projectsApi.generatePersonas('p1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        })
      )
      expect(result).toEqual(mockResponse)
    })

    it('includes filters when provided', async () => {
      const filters = {
        sources: ['twitter', 'instagram'],
        categories: ['delivery'],
        sentiments: ['negative'],
        persona_count: 5,
        custom_instructions: 'Focus on mobile users',
        days: 30,
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, personas: [] }),
      })

      await projectsApi.generatePersonas('p1', filters)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas/generate',
        expect.objectContaining({
          body: JSON.stringify(filters),
        })
      )
    })
  })

  describe('createPersona', () => {
    it('sends POST request with persona data', async () => {
      const persona = {
        name: 'Power User',
        tagline: 'Uses all features',
        description: 'A power user',
        pain_points: ['Slow loading'],
        goals: ['Efficiency'],
        behaviors: ['Daily usage'],
        demographics: { age: '25-34' },
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, persona: { ...persona, persona_id: 'per1' } }),
      })

      await projectsApi.createPersona('p1', persona)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(persona),
        })
      )
    })
  })

  describe('updatePersona', () => {
    it('sends PUT request with persona updates', async () => {
      const updates = { name: 'Updated Persona', tagline: 'New tagline' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.updatePersona('p1', 'per1', updates)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas/per1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(updates),
        })
      )
    })
  })

  describe('deletePersona', () => {
    it('sends DELETE request for persona', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.deletePersona('p1', 'per1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas/per1',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('importPersona', () => {
    it('sends POST request with PDF import data', async () => {
      const data = { input_type: 'pdf' as const, content: 'base64content', media_type: 'application/pdf' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job1', status: 'processing' }),
      })

      await projectsApi.importPersona('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas/import',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      )
    })

    it('sends POST request with text import data', async () => {
      const data = { input_type: 'text' as const, content: 'Persona description text' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job1', status: 'processing' }),
      })

      await projectsApi.importPersona('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/personas/import',
        expect.objectContaining({
          body: JSON.stringify(data),
        })
      )
    })
  })

  describe('projectChat', () => {
    it('sends POST request with message', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, response: 'AI response' }),
      })

      await projectsApi.projectChat('p1', 'What do users want?')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/chat',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'What do users want?', selected_personas: undefined, selected_documents: undefined }),
        })
      )
    })

    it('includes selected personas and documents', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, response: 'AI response' }),
      })

      await projectsApi.projectChat('p1', 'Question', ['per1', 'per2'], ['doc1'])

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/chat',
        expect.objectContaining({
          body: JSON.stringify({ message: 'Question', selected_personas: ['per1', 'per2'], selected_documents: ['doc1'] }),
        })
      )
    })
  })

  describe('runResearch', () => {
    it('sends POST request with research question', async () => {
      const data = { question: 'What are the main pain points?', title: 'Pain Points Research' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job1', status: 'running' }),
      })

      await projectsApi.runResearch('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/research',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      )
    })

    it('includes all filter options', async () => {
      const data = {
        question: 'Research question',
        title: 'Research Title',
        sources: ['twitter'],
        categories: ['delivery'],
        sentiments: ['negative'],
        days: 30,
        selected_persona_ids: ['per1'],
        selected_document_ids: ['doc1'],
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job1', status: 'running' }),
      })

      await projectsApi.runResearch('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/research',
        expect.objectContaining({
          body: JSON.stringify(data),
        })
      )
    })
  })

  describe('generateDocument', () => {
    it('sends POST request with document generation config', async () => {
      const data = {
        doc_type: 'prd' as const,
        title: 'Feature PRD',
        feature_idea: 'Add search',
        data_sources: { feedback: true, personas: true, documents: false, research: false },
        selected_persona_ids: ['per1'],
        selected_document_ids: [],
        feedback_sources: ['twitter'],
        feedback_categories: ['feature_request'],
        days: 30,
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job1', status: 'running' }),
      })

      await projectsApi.generateDocument('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/document',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      )
    })
  })

  describe('mergeDocuments', () => {
    it('sends POST request with merge config', async () => {
      const data = {
        output_type: 'prd' as const,
        title: 'Merged PRD',
        instructions: 'Combine these documents',
        selected_document_ids: ['doc1', 'doc2'],
        selected_persona_ids: ['per1'],
        use_feedback: true,
        feedback_sources: ['twitter'],
        feedback_categories: ['delivery'],
        days: 30,
      }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job1', status: 'running' }),
      })

      await projectsApi.mergeDocuments('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/documents/merge',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      )
    })
  })

  describe('getJobStatus', () => {
    it('fetches job status', async () => {
      const mockJob = { job_id: 'job1', status: 'completed', result: {} }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJob),
      })

      const result = await projectsApi.getJobStatus('p1', 'job1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/jobs/job1',
        expect.any(Object)
      )
      expect(result).toEqual(mockJob)
    })
  })

  describe('getJobs', () => {
    it('fetches all jobs for project', async () => {
      const mockJobs = { success: true, jobs: [{ job_id: 'job1', status: 'completed' }] }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockJobs),
      })

      const result = await projectsApi.getJobs('p1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/jobs',
        expect.any(Object)
      )
      expect(result).toEqual(mockJobs)
    })
  })

  describe('dismissJob', () => {
    it('sends DELETE request to dismiss job', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.dismissJob('p1', 'job1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/jobs/job1',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('createDocument', () => {
    it('sends POST request with document data', async () => {
      const data = { title: 'New Document', content: '# Content', document_type: 'custom' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, document: { ...data, document_id: 'd1' } }),
      })

      await projectsApi.createDocument('p1', data)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/documents',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(data),
        })
      )
    })
  })

  describe('updateDocument', () => {
    it('sends PUT request with document updates', async () => {
      const updates = { title: 'Updated Title', content: '# Updated Content' }
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.updateDocument('p1', 'd1', updates)

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/documents/d1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(updates),
        })
      )
    })
  })

  describe('deleteDocument', () => {
    it('sends DELETE request for document', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })

      await projectsApi.deleteDocument('p1', 'd1')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.example.com/projects/p1/documents/d1',
        expect.objectContaining({ method: 'DELETE' })
      )
    })
  })

  describe('error handling', () => {
    it('throws error on non-ok response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      await expect(projectsApi.getProject('nonexistent')).rejects.toThrow('API Error: 404')
    })

    it('throws error on 500 response', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      })

      await expect(projectsApi.getProjects()).rejects.toThrow('API Error: 500')
    })
  })
})
