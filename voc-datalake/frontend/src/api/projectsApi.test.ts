/**
 * @fileoverview Tests for Projects API client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  expectFetchedWith, fetchMock, installFetchMock, mockJsonOnce, mockStatusOnce, requestBody,
} from '@test/fetch-mock'

const API = 'https://api.example.com'

// Mock stores and auth before importing
vi.mock('../store/configStore', () => import('@test/api-mocks').then(m => m.configStoreMock('https://api.example.com')))
vi.mock('../runtimeConfig', () => import('@test/api-mocks').then(m => m.runtimeConfigMock('https://api.example.com')))
vi.mock('../services/auth', () => import('@test/api-mocks').then(m => m.authServiceMock()))

import { MAX_PROJECT_DETAIL_BATCH, projectsApi } from './projectsApi'
import { isRecord } from '../lib/typeGuards'

/** `JSON.parse`, typed as the `unknown` it really returns. */
function jsonValue(text: string): unknown {
  return JSON.parse(text)
}

const OK = { success: true }
const JOB_STARTED = { success: true, job_id: 'job1', status: 'running' }

describe('projectsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installFetchMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getProjects', () => {
    it('fetches projects list', async () => {
      mockJsonOnce({ projects: [{ project_id: 'p1', name: 'Project 1' }] })

      const result = await projectsApi.getProjects()

      expectFetchedWith(`${API}/projects`, {
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Authorization': 'mock-id-token',
        }),
      })
      // Normalized: the legacy row gains the sharing defaults (public, fail-closed access).
      expect(result.projects).toHaveLength(1)
      expect(result.projects[0]).toMatchObject({
        project_id: 'p1',
        name: 'Project 1',
        visibility: 'public',
        owner: null,
        access: { role: null, can_view: true, can_edit: false, can_manage: false },
        member_count: 0,
      })
    })
  })

  describe('getProject', () => {
    it('normalizes the project detail response after fetching by ID', async () => {
      mockJsonOnce({ project: { project_id: 'p1' }, personas: [], documents: [] })

      const result = await projectsApi.getProject('p1')

      expectFetchedWith(`${API}/projects/p1`)
      expect(result).toMatchObject({
        project: {
          project_id: 'p1',
          name: '',
          description: '',
          status: 'active',
          created_at: '',
          updated_at: '',
          persona_count: 0,
          document_count: 0,
        },
        personas: [],
        documents: [],
      })
    })
  })

  describe('getProjectDetails', () => {
    const detail = (id: string) => ({ project: { project_id: id }, documents: [{ document_id: `d_${id}`, document_type: 'prfaq' }] })

    it('reads N projects in ONE request and keeps only usable entries', async () => {
      mockJsonOnce({ details: [detail('p1'), { project: {} }, detail('p3')] })

      const result = await projectsApi.getProjectDetails(['p1', 'p2', 'p3'])

      expect(fetchMock()).toHaveBeenCalledTimes(1)
      expectFetchedWith(`${API}/projects?ids=p1%2Cp2%2Cp3`)
      expect(result.map((d) => d.project.project_id)).toStrictEqual(['p1', 'p3'])
      expect(result[0]?.personas).toStrictEqual([])
      expect(result[0]?.documents.map((d) => d.document_id)).toStrictEqual(['d_p1'])
    })

    it('splits at the server cap, one request per MAX_PROJECT_DETAIL_BATCH ids', async () => {
      const ids = Array.from({ length: MAX_PROJECT_DETAIL_BATCH + 1 }, (_, i) => `p${i}`)
      mockJsonOnce({ details: [] })
      mockJsonOnce({ details: [detail(`p${MAX_PROJECT_DETAIL_BATCH}`)] })

      const result = await projectsApi.getProjectDetails(ids)

      expect(fetchMock()).toHaveBeenCalledTimes(2)
      expect(result).toHaveLength(1)
    })

    it('treats a reply without a details list as no visible project', async () => {
      mockJsonOnce({ unexpected: true })
      expect(await projectsApi.getProjectDetails(['p1'])).toStrictEqual([])
    })
  })

  // Every write below is "one call, one URL, one method, the payload serialized
  // verbatim as the body" — so they share one table.
  describe('write requests', () => {
    const projectData = { name: 'New Project', description: 'Test description' }
    const persona = {
      name: 'Power User',
      tagline: 'Uses all features',
      pain_points: { current_challenges: ['Slow loading'] },
      goals_motivations: { primary_goal: 'Efficiency' },
      behaviors: { current_solutions: ['Daily usage'] },
      identity: { age_range: '25-34' },
    }
    const personaFilters = {
      sources: ['webscraper', 'manual_import'],
      categories: ['delivery'],
      sentiments: ['negative'],
      persona_count: 5,
      custom_instructions: 'Focus on mobile users',
      days: 30,
    }
    const researchData = {
      question: 'Research question',
      title: 'Research Title',
      sources: ['webscraper'],
      categories: ['delivery'],
      sentiments: ['negative'],
      days: 30,
      selected_persona_ids: ['per1'],
      selected_document_ids: ['doc1'],
    }
    const documentConfig = {
      doc_type: 'prd' as const,
      title: 'Feature PRD',
      feature_idea: 'Add search',
      data_sources: { feedback: true, personas: true, documents: false, research: false },
      selected_persona_ids: ['per1'],
      selected_document_ids: [],
      feedback_sources: ['webscraper'],
      feedback_categories: ['feature_request'],
      days: 30,
    }
    const mergeConfig = {
      output_type: 'prd' as const,
      title: 'Merged PRD',
      instructions: 'Combine these documents',
      selected_document_ids: ['doc1', 'doc2'],
      selected_persona_ids: ['per1'],
      use_feedback: true,
      feedback_sources: ['webscraper'],
      feedback_categories: ['delivery'],
      days: 30,
    }
    const newDocument: Parameters<typeof projectsApi.createDocument>[1] = {
      title: 'New Document', content: '# Content', document_type: 'custom',
    }

    // Was a PDF import. PDF is no longer an accepted input_type — the API refuses
    // it because nothing extracts PDF text — so this exercises the same
    // file-plus-media_type shape with the type that IS supported.
    const imageImport = { input_type: 'image' as const, content: 'base64content', media_type: 'image/png' }
    const textImport = { input_type: 'text' as const, content: 'Persona description text' }

    type Row = [title: string, call: () => Promise<unknown>, path: string, method: string, body: unknown, response?: unknown]

    it.each<Row>([
      ['createProject sends POST request with project data',
        () => projectsApi.createProject(projectData), '/projects', 'POST', projectData,
        { success: true, project: { ...projectData, project_id: 'p1' } }],
      ['createProject includes filters when provided',
        () => projectsApi.createProject({ name: 'Project', filters: { sources: ['webscraper'] } }),
        '/projects', 'POST', { name: 'Project', filters: { sources: ['webscraper'] } },
        { success: true, project: { name: 'Project', project_id: 'p1' } }],
      ['updateProject sends PUT request with project updates',
        () => projectsApi.updateProject('p1', { name: 'Updated Name', description: 'New description' }),
        '/projects/p1', 'PUT', { name: 'Updated Name', description: 'New description' }],
      ['deleteProject sends DELETE request for project',
        () => projectsApi.deleteProject('p1'), '/projects/p1', 'DELETE', undefined],
      ['generatePersonas sends POST request to generate personas',
        () => projectsApi.generatePersonas('p1'), '/projects/p1/personas/generate', 'POST', {}, JOB_STARTED],
      ['generatePersonas includes filters when provided',
        () => projectsApi.generatePersonas('p1', personaFilters), '/projects/p1/personas/generate', 'POST',
        personaFilters, JOB_STARTED],
      ['createPersona sends POST request with persona data',
        () => projectsApi.createPersona('p1', persona), '/projects/p1/personas', 'POST', persona,
        { success: true, persona: { ...persona, persona_id: 'per1' } }],
      ['updatePersona sends PUT request with persona updates',
        () => projectsApi.updatePersona('p1', 'per1', { name: 'Updated Persona', tagline: 'New tagline' }),
        '/projects/p1/personas/per1', 'PUT', { name: 'Updated Persona', tagline: 'New tagline' }],
      ['deletePersona sends DELETE request for persona',
        () => projectsApi.deletePersona('p1', 'per1'), '/projects/p1/personas/per1', 'DELETE', undefined],
      ['importPersona sends POST request with image import data',
        () => projectsApi.importPersona('p1', imageImport), '/projects/p1/personas/import', 'POST', imageImport,
        { success: true, job_id: 'job1', status: 'processing' }],
      ['importPersona sends POST request with text import data',
        () => projectsApi.importPersona('p1', textImport), '/projects/p1/personas/import', 'POST', textImport,
        { success: true, job_id: 'job1', status: 'processing' }],
      ['runResearch sends POST request with research question',
        () => projectsApi.runResearch('p1', { question: 'What are the main pain points?', title: 'Pain Points Research' }),
        '/projects/p1/research', 'POST', { question: 'What are the main pain points?', title: 'Pain Points Research' },
        JOB_STARTED],
      ['runResearch includes all filter options',
        () => projectsApi.runResearch('p1', researchData), '/projects/p1/research', 'POST', researchData, JOB_STARTED],
      ['generateDocument sends POST request with document generation config',
        () => projectsApi.generateDocument('p1', documentConfig), '/projects/p1/document', 'POST', documentConfig,
        JOB_STARTED],
      ['mergeDocuments sends POST request with merge config',
        () => projectsApi.mergeDocuments('p1', mergeConfig), '/projects/p1/documents/merge', 'POST', mergeConfig,
        JOB_STARTED],
      ['dismissJob sends DELETE request to dismiss job',
        () => projectsApi.dismissJob('p1', 'job1'), '/projects/p1/jobs/job1', 'DELETE', undefined],
      ['createDocument sends POST request with document data',
        () => projectsApi.createDocument('p1', newDocument), '/projects/p1/documents', 'POST', newDocument,
        { success: true, document: { ...newDocument, document_id: 'd1' } }],
      ['updateDocument sends PUT request with document updates',
        () => projectsApi.updateDocument('p1', 'd1', { title: 'Updated Title', content: '# Updated Content' }),
        '/projects/p1/documents/d1', 'PUT', { title: 'Updated Title', content: '# Updated Content' }],
      ['deleteDocument sends DELETE request for document',
        () => projectsApi.deleteDocument('p1', 'd1'), '/projects/p1/documents/d1', 'DELETE', undefined],
    ])('%s', async (_title, call, path, method, body, response = OK) => {
      mockJsonOnce(response)

      await call()

      expectFetchedWith(`${API}${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body) })
    })

    it('generatePersonas returns the job envelope, not personas', async () => {
      // The route is async: it answers with a job id, not with personas.
      const mockResponse = { ...JOB_STARTED, message: 'Persona generation started.' }
      mockJsonOnce(mockResponse)

      const result = await projectsApi.generatePersonas('p1')

      expect(result).toStrictEqual(mockResponse)
    })
  })

  describe('job reads', () => {
    it.each([
      ['getJobStatus fetches job status', () => projectsApi.getJobStatus('p1', 'job1'), '/projects/p1/jobs/job1',
        { job_id: 'job1', status: 'completed', result: {} }],
      ['getJobs fetches all jobs for project', () => projectsApi.getJobs('p1'), '/projects/p1/jobs',
        { success: true, jobs: [{ job_id: 'job1', status: 'completed' }] }],
    ])('%s', async (_title, call, path, response) => {
      mockJsonOnce(response)

      const result = await call()

      expectFetchedWith(`${API}${path}`)
      expect(result).toStrictEqual(response)
    })
  })

  describe('error handling', () => {
    it.each([
      ['a non-ok response', 404, () => projectsApi.getProject('nonexistent')],
      ['a 500 response', 500, () => projectsApi.getProjects()],
    ])('throws error on %s', async (_what, status, call) => {
      mockStatusOnce(status)

      await expect(call()).rejects.toThrow(`API Error: ${String(status)}`)
    })
  })

  // Sharing endpoints: URL, method, body, and that every response passes
  // through the lenient normalizers.
  describe('sharing endpoints', () => {
    function respond(body: unknown) {
      fetchMock().mockResolvedValueOnce(new Response(JSON.stringify(body)))
    }

    function lastCall(): { url: string; method: string; body: unknown } {
      const call: unknown[] = fetchMock().mock.lastCall ?? []
      const [url, init] = call
      const request = isRecord(init) ? init : {}
      return {
        url: String(url),
        method: typeof request['method'] === 'string' ? request['method'] : 'GET',
        body: typeof request['body'] === 'string' ? jsonValue(request['body']) : undefined,
      }
    }

    it('createProject sends visibility and normalizes the returned project', async () => {
      respond({ success: true, project: { project_id: 'p1', name: 'N', visibility: 'private' } })
      const result = await projectsApi.createProject({ name: 'N', visibility: 'private' })

      expect(lastCall()).toStrictEqual({
        url: `${API}/projects`, method: 'POST', body: { name: 'N', visibility: 'private' },
      })
      expect(result.success).toBe(true)
      expect(result.project).toMatchObject({ project_id: 'p1', visibility: 'private', access: { can_manage: false } })
    })

    it('setVisibility PUTs the visibility', async () => {
      respond({ success: true, visibility: 'public' })
      await projectsApi.setVisibility('p1', 'public')
      expect(lastCall()).toStrictEqual({
        url: `${API}/projects/p1/visibility`, method: 'PUT', body: { visibility: 'public' },
      })
    })

    it('getMembers normalizes the response', async () => {
      respond({ members: [{ sub: 's1', role: 'editor' }, { role: 'viewer' }] })
      const result = await projectsApi.getMembers('p1')

      expect(lastCall().url).toBe(`${API}/projects/p1/members`)
      expect(result.visibility).toBe('public')
      expect(result.members.map((m) => m.sub)).toStrictEqual(['s1'])
      expect(result.access.can_manage).toBe(false)
    })

    it('searchMemberCandidates URL-encodes q', async () => {
      respond({ users: [{ sub: 's1', username: 'a&b' }] })
      const users = await projectsApi.searchMemberCandidates('p1', 'a&b c')

      expect(lastCall().url).toBe(`${API}/projects/p1/members/candidates?q=a%26b+c`)
      expect(users.map((u) => u.sub)).toStrictEqual(['s1'])
    })

    it('addMember POSTs sub and role', async () => {
      respond({ success: true, member: { sub: 's1', role: 'viewer' } })
      const result = await projectsApi.addMember('p1', 's1', 'viewer')

      expect(lastCall()).toStrictEqual({
        url: `${API}/projects/p1/members`, method: 'POST', body: { sub: 's1', role: 'viewer' },
      })
      expect(result.member).toMatchObject({ sub: 's1', role: 'viewer' })
    })

    it('updateMemberRole and removeMember encode the sub in the path', async () => {
      respond({ success: true, member: { sub: 'mcp:x/y', role: 'editor' } })
      await projectsApi.updateMemberRole('p1', 'mcp:x/y', 'editor')
      expect(lastCall()).toStrictEqual({
        url: `${API}/projects/p1/members/mcp%3Ax%2Fy`, method: 'PUT', body: { role: 'editor' },
      })

      respond({ success: true })
      await projectsApi.removeMember('p1', 'mcp:x/y')
      expect(lastCall()).toStrictEqual({
        url: `${API}/projects/p1/members/mcp%3Ax%2Fy`, method: 'DELETE', body: undefined,
      })
    })

    it('transferOwnership POSTs the new owner sub', async () => {
      respond({ success: true, owner: { sub: 's1' } })
      await projectsApi.transferOwnership('p1', 's1')
      expect(lastCall()).toStrictEqual({
        url: `${API}/projects/p1/owner`, method: 'POST', body: { sub: 's1' },
      })
    })
  })
})


describe('date basis threading (issue #150)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installFetchMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function setDateBasis(basis: 'imported' | 'review') {
    const { useConfigStore } = await import('../store/configStore')
    // The mocked store hands out ONE state object (see `configStoreMock`), so
    // setting the basis on it is what every later `getState()` reads, as the
    // previous `mockReturnValue` override did.
    Object.assign(useConfigStore.getState(), { dateBasis: basis })
  }

  it('persona generation carries date_basis on review basis', async () => {
    await setDateBasis('review')
    mockJsonOnce(OK)

    await projectsApi.generatePersonas('p1', { days: 30, persona_count: 3 })

    expect(requestBody()).toMatchObject({ date_basis: 'review', days: 30 })
  })

  it('research carries date_basis on review basis', async () => {
    await setDateBasis('review')
    mockJsonOnce(OK)

    await projectsApi.runResearch('p1', { question: 'What hurts?' })

    expect(requestBody()).toMatchObject({ date_basis: 'review' })
  })

  it('document generation carries date_basis on review basis', async () => {
    await setDateBasis('review')
    mockJsonOnce(OK)

    await projectsApi.generateDocument('p1', {
      doc_type: 'prd',
      title: 'T',
      feature_idea: 'F',
      data_sources: { feedback: true, personas: false, documents: false, research: false },
      selected_persona_ids: [],
      selected_document_ids: [],
      feedback_sources: [],
      feedback_categories: [],
      days: 30,
    })

    expect(requestBody()).toMatchObject({ date_basis: 'review' })
  })

  it('payloads stay unchanged on the default imported basis', async () => {
    await setDateBasis('imported')
    mockJsonOnce(OK)

    await projectsApi.generatePersonas('p1', { days: 30 })

    expect(requestBody()).not.toHaveProperty('date_basis')
  })

  it('an explicit caller value wins over the store', async () => {
    await setDateBasis('review')
    mockJsonOnce(OK)

    // Callers may pass their own basis in `data`; it spreads after the store
    // default, so it takes precedence. A variable, not a literal: the declared
    // parameter has no `date_basis`, and only a literal gets excess-property checks.
    const data = { question: 'q', date_basis: 'imported' }
    await projectsApi.runResearch('p1', data)

    expect(requestBody()).toMatchObject({ date_basis: 'imported' })
  })
})
