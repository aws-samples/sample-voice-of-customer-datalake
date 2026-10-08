import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const m = vi.hoisted(() => ({
  api: {
    setProblemResolved: vi.fn(),
    updateFeedbackForm: vi.fn(),
    getBrandSettings: vi.fn(),
    saveBrandSettings: vi.fn(),
  },
  fetchApi: vi.fn(),
  projectsApi: {
    createProject: vi.fn(),
    updateDocument: vi.fn<(projectId: string, documentId: string, body: Record<string, unknown>) => Promise<unknown>>(),
    createDocument: vi.fn(),
    deleteDocument: vi.fn(),
    updatePersona: vi.fn(),
    addPersonaNote: vi.fn(),
    updateProject: vi.fn(),
    updateProductContext: vi.fn(),
    runResearch: vi.fn(),
    generateDocument: vi.fn(),
    generatePersonas: vi.fn(),
    mergeDocuments: vi.fn(),
    getProject: vi.fn(),
  },
  scrapersApi: { runScraper: vi.fn() },
}))

vi.mock('../../api/client', () => ({ api: m.api, fetchApi: m.fetchApi }))
vi.mock('../../api/projectsApi', () => ({ projectsApi: m.projectsApi }))
vi.mock('../../api/scrapersApi', () => ({ scrapersApi: m.scrapersApi }))

import { getWriteTool } from './registry'
import { createShownRecord, recordBrandBase } from './shown'
import { BRAND_CHANGED_MESSAGE } from './executors'
import type { ShownRecord } from './shown'
import { useConfigStore } from '../../store/configStore'
import { useAuthStore } from '../../store/authStore'
import type { PageContext } from '../contract'

const P = 'proj_1'
const PAGE: PageContext = { kind: 'project', path: `/projects/${P}`, projectId: P }
const JOB = { success: true, job_id: 'job_9', status: 'pending', message: 'ok' }

function setup(shown?: ShownRecord) {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const run = (name: string, args: unknown) => {
    const def = getWriteTool(name)
    if (def === undefined) throw new Error(`no tool ${name}`)
    return def.execute(args, shown === undefined ? { queryClient, page: PAGE } : { queryClient, page: PAGE, shown })
  }
  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
  return { run, invalidatedKeys }
}

beforeEach(() => {
  vi.clearAllMocks()
  useConfigStore.setState({ timeRange: '7d', customDays: null, dateBasis: 'imported' })
  m.projectsApi.runResearch.mockResolvedValue(JOB)
  m.projectsApi.generateDocument.mockResolvedValue(JOB)
  m.projectsApi.generatePersonas.mockResolvedValue(JOB)
  m.projectsApi.mergeDocuments.mockResolvedValue(JOB)
})

describe('write-tool executors', () => {
  it('set_feedback_category → PUT /feedback/{id}/category, refreshes feedback and metrics', async () => {
    m.fetchApi.mockResolvedValue({ success: true, feedback: { feedback_id: 'fb_1', category: 'pricing', category_source: 'manual' } })
    const { run, invalidatedKeys } = setup()
    const result = await run('set_feedback_category', { feedback_id: 'fb_1', category: 'pricing' })
    expect(m.fetchApi).toHaveBeenCalledWith('/feedback/fb_1/category', { method: 'PUT', body: JSON.stringify({ category: 'pricing' }) })
    expect(result.data).toStrictEqual({ feedback_id: 'fb_1', category: 'pricing' })
    expect(invalidatedKeys()).toStrictEqual(expect.arrayContaining(['["feedback"]', '["summary"]', '["categories"]']))
  })

  it('set_feedback_category sends the subcategory when one is proposed', async () => {
    m.fetchApi.mockResolvedValue({ success: true, feedback: { feedback_id: 'fb_1', category: 'delivery', subcategory: 'late_delivery' } })
    const { run } = setup()
    const result = await run('set_feedback_category', { feedback_id: 'fb_1', category: 'delivery', subcategory: 'late_delivery' })
    expect(m.fetchApi).toHaveBeenCalledWith('/feedback/fb_1/category', {
      method: 'PUT', body: JSON.stringify({ category: 'delivery', subcategory: 'late_delivery' }),
    })
    expect(result.summary).toContain('delivery / late_delivery')
  })
  it('create_project → projectsApi.createProject, refreshes the project list', async () => {
    m.projectsApi.createProject.mockResolvedValue({ success: true, project: { project_id: 'proj_new' } })
    const { run, invalidatedKeys } = setup()
    const result = await run('create_project', { name: 'Acme' })
    expect(m.projectsApi.createProject).toHaveBeenCalledWith({ name: 'Acme' })
    expect(result.data).toStrictEqual({ project_id: 'proj_new' })
    expect(result.summary).toContain('proj_new')
    expect(invalidatedKeys()).toContain('["projects"]')
  })

  // Regression: under per-project permissions createProject normalises its
  // response and returns `project: null` when the body carries no parseable
  // project; the executor dereferenced it and turned a successful create into
  // a "failed" approval outcome.
  it('create_project reports success without an id when the response has no parseable project', async () => {
    m.projectsApi.createProject.mockResolvedValue({ success: true, project: null })
    const { run, invalidatedKeys } = setup()
    const result = await run('create_project', { name: 'Acme' })
    expect(result.summary).toBe('Created project "Acme".')
    expect(result.data).toBeUndefined()
    expect(invalidatedKeys()).toContain('["projects"]')
  })

  it('set_problem_resolved → api.setProblemResolved, refreshes resolved problems', async () => {
    m.api.setProblemResolved.mockResolvedValue({ success: true })
    const { run, invalidatedKeys } = setup()
    await run('set_problem_resolved', { problem_key: 'k1', resolved: false })
    expect(m.api.setProblemResolved).toHaveBeenCalledWith('k1', false)
    expect(invalidatedKeys()).toContain('["resolved-problems"]')
  })

  it('update_document sends content (+title) and refreshes the project record', async () => {
    m.projectsApi.updateDocument.mockResolvedValue({ success: true, document: null })
    const { run, invalidatedKeys } = setup()
    await run('update_document', { project_id: P, document_id: 'd1', content: 'body', title: 'New', change_summary: 's' })
    const [projectId, documentId, body] = m.projectsApi.updateDocument.mock.calls[0] ?? ['', '', {}]
    expect({ projectId, documentId, ...body, edit_id: typeof body.edit_id }).toStrictEqual(
      { projectId: P, documentId: 'd1', content: 'body', title: 'New', edit_id: 'string' })
    expect(invalidatedKeys()).toStrictEqual(expect.arrayContaining(['["project","proj_1"]', '["projects"]', '["all-project-details"]']))
  })

  // QA s3 F4: an edit is a new version, so the model must be told the NEW id.
  it('update_document reports the saved version and its id', async () => {
    m.projectsApi.updateDocument.mockResolvedValue({ success: true, document: { document_id: 'prd_v3', version: 3 } })
    const { run } = setup()
    const result = await run('update_document', { project_id: P, document_id: 'prd_v2', content: 'body', change_summary: 'tightened scope' })
    expect(result.data).toStrictEqual({ document_id: 'prd_v3' })
    expect(result.summary).toBe('Saved document prd_v3 as version 3: tightened scope. The previous version is kept in its Versions list.')
  })

  it('create_document creates a custom document', async () => {
    m.projectsApi.createDocument.mockResolvedValue({ success: true, document: { document_id: 'doc_7' } })
    const { run } = setup()
    const result = await run('create_document', { project_id: P, title: 'T', content: 'C' })
    expect(m.projectsApi.createDocument).toHaveBeenCalledWith(P, { title: 'T', content: 'C', document_type: 'custom' })
    expect(result.data).toStrictEqual({ document_id: 'doc_7' })
  })

  it('delete_document → projectsApi.deleteDocument', async () => {
    m.projectsApi.deleteDocument.mockResolvedValue({ success: true })
    const { run } = setup()
    await run('delete_document', { project_id: P, document_id: 'd1', reason: 'dup' })
    expect(m.projectsApi.deleteDocument).toHaveBeenCalledWith(P, 'd1')
  })

  it('update_persona passes only the validated updates', async () => {
    m.projectsApi.updatePersona.mockResolvedValue({ success: true })
    const { run } = setup()
    await run('update_persona', { project_id: P, persona_id: 'p1', updates: { tagline: 'T', identity: { bio: 'B' } } })
    expect(m.projectsApi.updatePersona).toHaveBeenCalledWith(P, 'p1', { tagline: 'T', identity: { bio: 'B' } })
  })

  it('add_persona_note posts through projectsApi.addPersonaNote with the signed-in author', async () => {
    useAuthStore.setState({ user: { username: 'alice', email: 'a@example.com', groups: [] } })
    m.projectsApi.addPersonaNote.mockResolvedValue({ success: true, note: { note_id: 'note_1' } })
    const { run } = setup()
    const result = await run('add_persona_note', { project_id: P, persona_id: 'p1', text: 'Insight' })
    expect(m.projectsApi.addPersonaNote).toHaveBeenCalledWith(P, 'p1', { text: 'Insight', author: 'alice' })
    expect(result.data).toStrictEqual({ note_id: 'note_1' })
  })

  it('update_project sends only the provided fields', async () => {
    m.projectsApi.updateProject.mockResolvedValue({ success: true })
    const { run } = setup()
    await run('update_project', { project_id: P, description: 'D' })
    expect(m.projectsApi.updateProject).toHaveBeenCalledWith(P, { description: 'D' })
  })

  it('update_product_context patches and refreshes the product-context key', async () => {
    m.projectsApi.updateProductContext.mockResolvedValue({ context: {} })
    const { run, invalidatedKeys } = setup()
    await run('update_product_context', { project_id: P, updates: { one_liner: 'x' } })
    expect(m.projectsApi.updateProductContext).toHaveBeenCalledWith(P, { one_liner: 'x' })
    expect(invalidatedKeys()).toContain('["product-context","proj_1"]')
  })

  it('start_research fills the wizard defaults and the app time range', async () => {
    useConfigStore.setState({ timeRange: '30d' })
    const { run, invalidatedKeys } = setup()
    const result = await run('start_research', { project_id: P, question: 'Why churn?', persona_ids: ['p1'] })
    expect(m.projectsApi.runResearch).toHaveBeenCalledWith(P, expect.objectContaining({
      question: 'Why churn?',
      title: 'Why churn?',
      sources: [], categories: [], sentiments: [],
      days: 30,
      selected_persona_ids: ['p1'],
      selected_document_ids: [],
      use_web_search: false,
    }))
    expect(result.data).toStrictEqual({ job_id: 'job_9' })
    expect(invalidatedKeys()).toContain('["project-jobs","proj_1"]')
  })

  it('generate_document maps onto GenerateDocumentBody', async () => {
    const { run } = setup()
    await run('generate_document', { project_id: P, doc_type: 'prd', title: 'T', feature_idea: 'I', document_ids: ['d1'] })
    expect(m.projectsApi.generateDocument).toHaveBeenCalledWith(P, expect.objectContaining({
      doc_type: 'prd',
      title: 'T',
      feature_idea: 'I',
      data_sources: { feedback: true, personas: false, documents: true, research: true },
      selected_persona_ids: [],
      selected_document_ids: ['d1'],
      feedback_sources: [],
      feedback_categories: [],
      days: 7,
    }))
  })

  it('generate_personas sends count, instructions and the time range', async () => {
    useConfigStore.setState({ timeRange: 'custom', customDays: 45 })
    const { run } = setup()
    await run('generate_personas', { project_id: P, persona_count: 4 })
    expect(m.projectsApi.generatePersonas).toHaveBeenCalledWith(P, expect.objectContaining({
      persona_count: 4, custom_instructions: '', days: 45, sources: [], categories: [], sentiments: [],
    }))
  })

  it('merge_documents maps document_ids onto selected_document_ids', async () => {
    const { run } = setup()
    await run('merge_documents', { project_id: P, output_type: 'prfaq', title: 'M', instructions: 'I', document_ids: ['a', 'b'] })
    expect(m.projectsApi.mergeDocuments).toHaveBeenCalledWith(P, expect.objectContaining({
      output_type: 'prfaq', title: 'M', instructions: 'I', selected_document_ids: ['a', 'b'], selected_persona_ids: [], use_feedback: false,
    }))
  })

  it('update_feedback_form → api.updateFeedbackForm, refreshes the form list', async () => {
    m.api.updateFeedbackForm.mockResolvedValue({ success: true })
    const { run, invalidatedKeys } = setup()
    await run('update_feedback_form', { form_id: 'f1', updates: { enabled: false } })
    expect(m.api.updateFeedbackForm).toHaveBeenCalledWith('f1', { enabled: false })
    expect(invalidatedKeys()).toContain('["feedback-forms"]')
  })

  it('run_scraper → scrapersApi.runScraper', async () => {
    m.scrapersApi.runScraper.mockResolvedValue({ success: true, execution_id: 'ex1', status: 'running' })
    const { run, invalidatedKeys } = setup()
    const result = await run('run_scraper', { scraper_id: 's1' })
    expect(m.scrapersApi.runScraper).toHaveBeenCalledWith('s1')
    expect(result.data).toStrictEqual({ execution_id: 'ex1' })
    expect(invalidatedKeys()).toContain('["scrapers"]')
  })

  const BRAND = { brand_name: 'Old', brand_handles: ['@old'], hashtags: ['#a'], urls_to_track: ['https://a.example'] }

  it('save_brand_settings saves the merge against the base the card showed', async () => {
    m.api.getBrandSettings.mockResolvedValue(BRAND)
    m.api.saveBrandSettings.mockResolvedValue({ success: true })
    const shown = createShownRecord()
    recordBrandBase(shown, BRAND)
    const { run, invalidatedKeys } = setup(shown)
    await run('save_brand_settings', { hashtags: ['#b'] })
    expect(m.api.saveBrandSettings).toHaveBeenCalledWith({
      brand_name: 'Old', brand_handles: ['@old'], hashtags: ['#b'], urls_to_track: ['https://a.example'],
    })
    expect(invalidatedKeys()).toContain('["brand-settings"]')
  })

  it.each([
    {
      when: 'the settings changed since the card showed them',
      current: { ...BRAND, brand_handles: ['@someone-else'] },
      shown: (): ShownRecord | undefined => {
        const record = createShownRecord()
        recordBrandBase(record, BRAND)
        return record
      },
    },
    { when: 'no merge was shown', current: BRAND, shown: (): ShownRecord | undefined => undefined },
  ])('save_brand_settings refuses to save when $when', async ({ current, shown }) => {
    m.api.getBrandSettings.mockResolvedValue(current)
    const { run } = setup(shown())
    await expect(run('save_brand_settings', { hashtags: ['#b'] })).rejects.toThrow(BRAND_CHANGED_MESSAGE)
    expect(m.api.saveBrandSettings).not.toHaveBeenCalled()
  })

  it('job tools send the time window and language captured when the card rendered, not the current ones', async () => {
    useConfigStore.setState({ timeRange: '30d' })
    const shown = createShownRecord()
    useConfigStore.setState({ timeRange: '7d' })
    const { run } = setup(shown)
    await run('generate_personas', { project_id: P, persona_count: 2 })
    expect(m.projectsApi.generatePersonas).toHaveBeenCalledWith(P, expect.objectContaining({
      days: 30, response_language: shown.job.responseLanguage,
    }))
  })

  it('propagates a client failure (the card turns it into a safe message)', async () => {
    m.projectsApi.deleteDocument.mockRejectedValue(new Error('API Error: 403'))
    const { run, invalidatedKeys } = setup()
    await expect(run('delete_document', { project_id: P, document_id: 'd1', reason: 'duplicate' })).rejects.toThrow('API Error: 403')
    expect(invalidatedKeys()).toStrictEqual([])
  })
})
