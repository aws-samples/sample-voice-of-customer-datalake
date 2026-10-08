/**
 * @fileoverview REST executors for the write tools — the ONLY place an approved
 * tool call becomes a request. Every call goes through the existing API client
 * (`fetchApi` → the user's own Cognito token, 401 refresh), never a new path.
 *
 * Job bodies are filled the way the Project Detail wizards fill them
 * (`pages/ProjectDetail/useProjectData.ts` + `useProjectWizardState.ts`), with
 * the `days` and response language the card SHOWED when it rendered (`shown.ts`:
 * the global time-range picker and UI language at that moment); `date_basis` is added by `projectsApi` itself
 * (`getDateBasisBodyParams`) — the model never chooses either.
 *
 * Summaries go to the model, in English, and name ids so it can refer back.
 *
 * @module assistant/approvals/executors
 */
import { api } from '../../api/client'
import { setFeedbackCategory } from '../../api/feedbackCategoryApi'
import { projectsApi } from '../../api/projectsApi'
import { scrapersApi } from '../../api/scrapersApi'
import { useAuthStore } from '../../store/authStore'
import { invalidateKeys, keysFor } from './invalidation'
import { StaleApprovalError, currentJobEnvironment, sameBrandSettings, shownOf } from './shown'
import type { BrandSettings, JobEnvironment } from './shown'
import type { QueryKey } from '@tanstack/react-query'
import type { WriteToolExecutionContext } from '../types'
import type {
  AddPersonaNoteArgs, CreateDocumentArgs, CreateProjectArgs, DeleteDocumentArgs,
  GenerateDocumentArgs, GeneratePersonasArgs, MergeDocumentsArgs, RunScraperArgs,
  SaveBrandSettingsArgs, SetFeedbackCategoryArgs, SetProblemResolvedArgs, StartResearchArgs, UpdateDocumentArgs,
  UpdateFeedbackFormArgs, UpdatePersonaArgs, UpdateProductContextArgs, UpdateProjectArgs,
} from './schemas'

interface ExecutionResult {
  summary: string
  data?: unknown
}

type Executor<A> = (args: A, ctx: WriteToolExecutionContext) => Promise<ExecutionResult>

/** Fire-and-forget: the write already succeeded, a slow refetch must not hold the outcome. */
function refresh(ctx: WriteToolExecutionContext, keys: readonly QueryKey[]): void {
  void invalidateKeys(ctx.queryClient, keys)
}

/** The time window and language the card showed (captured at render), else the app's current ones. */
function jobEnvironment(ctx: WriteToolExecutionContext): JobEnvironment {
  return shownOf(ctx)?.job ?? currentJobEnvironment()
}

// ── Brand settings (shared with the preview) ─────────────────────────────────

/** The proposed fields replace the current ones; absent fields are kept. */
export function mergeBrandSettings(current: BrandSettings, proposed: SaveBrandSettingsArgs): BrandSettings {
  return {
    brand_name: proposed.brand_name ?? current.brand_name,
    brand_handles: proposed.brand_handles ?? current.brand_handles,
    hashtags: proposed.hashtags ?? current.hashtags,
    urls_to_track: proposed.urls_to_track ?? current.urls_to_track,
  }
}

export async function fetchBrandSettings(): Promise<BrandSettings> {
  const raw = await api.getBrandSettings()
  return {
    brand_name: typeof raw.brand_name === 'string' ? raw.brand_name : '',
    brand_handles: Array.isArray(raw.brand_handles) ? raw.brand_handles : [],
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags : [],
    urls_to_track: Array.isArray(raw.urls_to_track) ? raw.urls_to_track : [],
  }
}

// ── Executors ────────────────────────────────────────────────────────────────

const createProject: Executor<CreateProjectArgs> = async (args, ctx) => {
  const res = await projectsApi.createProject({ name: args.name, ...(args.description === undefined ? {} : { description: args.description }) })
  refresh(ctx, keysFor.projectList())
  // The API may answer without a parseable project; report the create without inventing an id.
  const projectId = res.project?.project_id
  return projectId === undefined
    ? { summary: `Created project "${args.name}".` }
    : { summary: `Created project "${args.name}" (${projectId}).`, data: { project_id: projectId } }
}

const setProblemResolved: Executor<SetProblemResolvedArgs> = async (args, ctx) => {
  await api.setProblemResolved(args.problem_key, args.resolved)
  refresh(ctx, keysFor.resolvedProblems())
  return { summary: `Marked problem "${args.problem_key}" as ${args.resolved ? 'resolved' : 'unresolved'}.` }
}

const setFeedbackCategoryExecutor: Executor<SetFeedbackCategoryArgs> = async (args, ctx) => {
  const result = await setFeedbackCategory(args.feedback_id, {
    category: args.category,
    ...(args.subcategory === undefined ? {} : { subcategory: args.subcategory }),
  })
  refresh(ctx, keysFor.feedbackCategory())
  const category = result?.category ?? args.category
  const subcategory = result?.subcategory ?? args.subcategory
  const label = subcategory === undefined ? category : `${category} / ${subcategory}`
  return {
    summary: `Changed the category of feedback ${args.feedback_id} to ${label} (recorded as a manual correction).`,
    data: { feedback_id: args.feedback_id, category, ...(subcategory === undefined ? {} : { subcategory }) },
  }
}

const updateDocument: Executor<UpdateDocumentArgs> = async (args, ctx) => {
  const res = await projectsApi.updateDocument(args.project_id, args.document_id, {
    content: args.content,
    ...(args.title === undefined ? {} : { title: args.title }),
    edit_id: crypto.randomUUID(),
  })
  refresh(ctx, keysFor.projectRecord(args.project_id))
  // Every edit is a new version; a PRD / PR-FAQ version has its own id, which is
  // the one any follow-up call must name. The edited version stays retrievable.
  const saved = res.document
  const version = saved?.version === undefined ? '' : ` as version ${String(saved.version)}`
  const documentId = saved?.document_id ?? args.document_id
  return {
    summary: `Saved document ${documentId}${version}: ${args.change_summary}. The previous version is kept in its Versions list.`.trim(),
    data: { document_id: documentId },
  }
}

const createDocument: Executor<CreateDocumentArgs> = async (args, ctx) => {
  const res = await projectsApi.createDocument(args.project_id, { title: args.title, content: args.content, document_type: 'custom' })
  refresh(ctx, keysFor.projectRecord(args.project_id))
  return { summary: `Created document "${args.title}" (${res.document.document_id}).`, data: { document_id: res.document.document_id } }
}

const deleteDocument: Executor<DeleteDocumentArgs> = async (args, ctx) => {
  await projectsApi.deleteDocument(args.project_id, args.document_id)
  refresh(ctx, keysFor.projectRecord(args.project_id))
  return { summary: `Deleted document ${args.document_id}.`, data: { document_id: args.document_id } }
}

const updatePersona: Executor<UpdatePersonaArgs> = async (args, ctx) => {
  await projectsApi.updatePersona(args.project_id, args.persona_id, args.updates)
  refresh(ctx, keysFor.projectRecord(args.project_id))
  const fields = Object.keys(args.updates).join(', ')
  return { summary: `Updated persona ${args.persona_id} (${fields}).`, data: { persona_id: args.persona_id } }
}

const addPersonaNote: Executor<AddPersonaNoteArgs> = async (args, ctx) => {
  const author = useAuthStore.getState().user?.username
  const res = await projectsApi.addPersonaNote(args.project_id, args.persona_id, {
    text: args.text,
    ...(author === undefined || author === '' ? {} : { author }),
  })
  refresh(ctx, keysFor.projectRecord(args.project_id))
  return { summary: `Added a research note to persona ${args.persona_id}.`, data: { note_id: res.note?.note_id } }
}

const updateProject: Executor<UpdateProjectArgs> = async (args, ctx) => {
  await projectsApi.updateProject(args.project_id, {
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.description === undefined ? {} : { description: args.description }),
  })
  refresh(ctx, keysFor.projectRecord(args.project_id))
  return { summary: `Updated project ${args.project_id}.` }
}

const updateProductContext: Executor<UpdateProductContextArgs> = async (args, ctx) => {
  await projectsApi.updateProductContext(args.project_id, args.updates)
  refresh(ctx, keysFor.productContext(args.project_id))
  return { summary: `Updated the product context (${Object.keys(args.updates).join(', ')}).` }
}

function jobResult(kind: string, projectId: string, ctx: WriteToolExecutionContext, res: { job_id: string }): ExecutionResult {
  refresh(ctx, keysFor.projectJobs(projectId))
  return { summary: `Started ${kind} job ${res.job_id}; it runs in the background and appears in the project's Jobs.`, data: { job_id: res.job_id } }
}

const startResearch: Executor<StartResearchArgs> = async (args, ctx) => {
  const env = jobEnvironment(ctx)
  const res = await projectsApi.runResearch(args.project_id, {
    question: args.question,
    title: args.title === undefined || args.title.trim() === '' ? args.question.slice(0, 100) : args.title,
    sources: [],
    categories: [],
    sentiments: [],
    days: env.days,
    selected_persona_ids: args.persona_ids ?? [],
    selected_document_ids: args.document_ids ?? [],
    response_language: env.responseLanguage,
    use_web_search: args.use_web_search ?? false,
  })
  return jobResult('research', args.project_id, ctx, res)
}

const generateDocument: Executor<GenerateDocumentArgs> = async (args, ctx) => {
  const env = jobEnvironment(ctx)
  const personaIds = args.persona_ids ?? []
  const documentIds = args.document_ids ?? []
  const res = await projectsApi.generateDocument(args.project_id, {
    doc_type: args.doc_type,
    title: args.title,
    feature_idea: args.feature_idea,
    data_sources: {
      feedback: true,
      personas: personaIds.length > 0,
      // The wizard sends research ids in the same list, flagged separately; the
      // model's single list may hold either, so both flags follow it.
      documents: documentIds.length > 0,
      research: documentIds.length > 0,
    },
    selected_persona_ids: personaIds,
    selected_document_ids: documentIds,
    feedback_sources: [],
    feedback_categories: [],
    days: env.days,
    response_language: env.responseLanguage,
  })
  return jobResult(args.doc_type === 'prd' ? 'PRD generation' : 'PR/FAQ generation', args.project_id, ctx, res)
}

const generatePersonas: Executor<GeneratePersonasArgs> = async (args, ctx) => {
  const env = jobEnvironment(ctx)
  const res = await projectsApi.generatePersonas(args.project_id, {
    sources: [],
    categories: [],
    sentiments: [],
    persona_count: args.persona_count,
    custom_instructions: args.custom_instructions ?? '',
    days: env.days,
    response_language: env.responseLanguage,
  })
  return jobResult('persona generation', args.project_id, ctx, res)
}

const mergeDocuments: Executor<MergeDocumentsArgs> = async (args, ctx) => {
  const env = jobEnvironment(ctx)
  const res = await projectsApi.mergeDocuments(args.project_id, {
    output_type: args.output_type,
    title: args.title,
    instructions: args.instructions,
    selected_document_ids: args.document_ids,
    selected_persona_ids: args.persona_ids ?? [],
    use_feedback: false,
    feedback_sources: [],
    feedback_categories: [],
    days: env.days,
    response_language: env.responseLanguage,
  })
  return jobResult('document merge', args.project_id, ctx, res)
}

const updateFeedbackForm: Executor<UpdateFeedbackFormArgs> = async (args, ctx) => {
  await api.updateFeedbackForm(args.form_id, args.updates)
  refresh(ctx, keysFor.feedbackForms())
  return { summary: `Updated feedback form ${args.form_id} (${Object.keys(args.updates).join(', ')}).` }
}

const runScraper: Executor<RunScraperArgs> = async (args, ctx) => {
  const res = await scrapersApi.runScraper(args.scraper_id)
  refresh(ctx, keysFor.scrapers())
  return { summary: `Started scraper ${args.scraper_id} (execution ${res.execution_id}).`, data: { execution_id: res.execution_id } }
}

export const BRAND_CHANGED_MESSAGE = 'The brand settings changed since this approval was shown (or were never shown); nothing was saved. Review the change again.'

/**
 * Save exactly the merge the card displayed: re-fetch the current settings and
 * refuse when they differ from the base the preview merged into.
 */
const saveBrandSettings: Executor<SaveBrandSettingsArgs> = async (args, ctx) => {
  const shownBase = shownOf(ctx)?.brandBase
  const current = await fetchBrandSettings()
  if (shownBase === undefined || !sameBrandSettings(shownBase, current)) throw new StaleApprovalError(BRAND_CHANGED_MESSAGE)
  const merged = mergeBrandSettings(shownBase, args)
  await api.saveBrandSettings(merged)
  refresh(ctx, keysFor.brandSettings())
  return { summary: 'Saved the brand settings.', data: merged }
}

export const executors = {
  createProject,
  setProblemResolved,
  setFeedbackCategory: setFeedbackCategoryExecutor,
  updateDocument,
  createDocument,
  deleteDocument,
  updatePersona,
  addPersonaNote,
  updateProject,
  updateProductContext,
  startResearch,
  generateDocument,
  generatePersonas,
  mergeDocuments,
  updateFeedbackForm,
  runScraper,
  saveBrandSettings,
}
