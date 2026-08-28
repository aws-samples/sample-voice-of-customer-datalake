// Projects API - extracted from client.ts to reduce file size
// Uses shared fetchApi from client.ts for consistent 401 retry + token refresh
import { fetchApi } from './client'
import { getDateBasisBodyParams } from './baseUrl'
import type {
  Project, ProjectDetail, ProjectPersona, ProjectDocument, ProjectJob,
  ProductContext, ProductDoc, ProductInterviewTurnResponse,
  // The document-generation request body; see its declaration for why it is a
  // named type rather than an object literal spelled out here. `BothWays` comes with
  // it for the signature pin at the foot of this file.
  GenerateDocumentBody, BothWays,
} from './types'

export const projectsApi = {
  getProjects: () => fetchApi<{ projects: Project[] }>('/projects'),

  createProject: (data: {
    name: string;
    description?: string;
    filters?: Record<string, unknown>
  }) =>
    fetchApi<{
      success: boolean;
      project: Project
    }>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getProject: (id: string) => fetchApi<ProjectDetail>(`/projects/${id}`),

  updateProject: (id: string, data: Partial<Project>) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
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
    // Async since the work moved to the persona-generator Lambda: the route answers
    // with a job id and the UI polls the jobs list. It has not returned `personas`
    // (or an `analysis` blob) for some time — the old synchronous shape lingered here
    // as a type that no longer described any response the endpoint sends.
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string;
    }>(`/projects/${projectId}/personas/generate`, {
      method: 'POST',
      body: JSON.stringify({ ...getDateBasisBodyParams(), ...(filters ?? {}) }),
    }),

  createPersona: (projectId: string, persona: Omit<ProjectPersona, 'persona_id' | 'created_at'>) =>
    fetchApi<{
      success: boolean;
      persona: ProjectPersona
    }>(`/projects/${projectId}/personas`, {
      method: 'POST',
      body: JSON.stringify(persona),
    }),

  updatePersona: (projectId: string, personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deletePersona: (projectId: string, personaId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, { method: 'DELETE' }),

  importPersona: (projectId: string, data: {
    // No 'pdf': the API refuses it (nothing extracts PDF text), so advertising it
    // in the client type would be a compile-time promise the server breaks.
    input_type: 'image' | 'text';
    content: string;
    media_type?: string
  }) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/personas/import`, {
      method: 'POST',
      body: JSON.stringify(data),
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
    use_web_search?: boolean
  }) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/research`, {
      method: 'POST',
      body: JSON.stringify({ ...getDateBasisBodyParams(), ...data }),
    }),

  generateDocument: (projectId: string, data: GenerateDocumentBody) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/document`, {
      method: 'POST',
      // `data` is only spread into the body — nothing here constrains its type. What
      // stops the annotation above being widened is
      // `GenerateDocumentTakesTheSharedBody` at the foot of this file; see there for
      // why it is a type-level comparison and not a clause on this object (#381).
      body: JSON.stringify({ ...getDateBasisBodyParams(), ...data }),
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
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/documents/merge`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getJobStatus: (projectId: string, jobId: string) =>
    fetchApi<ProjectJob>(`/projects/${projectId}/jobs/${jobId}`),

  getJobs: (projectId: string) =>
    fetchApi<{
      success: boolean;
      jobs: ProjectJob[]
    }>(`/projects/${projectId}/jobs`),

  dismissJob: (projectId: string, jobId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/jobs/${jobId}`, { method: 'DELETE' }),

  createDocument: (projectId: string, data: {
    title: string;
    content: string;
    document_type?: string
  }) =>
    fetchApi<{
      success: boolean;
      document: ProjectDocument
    }>(`/projects/${projectId}/documents`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateDocument: (projectId: string, documentId: string, data: {
    title?: string;
    content?: string
  }) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteDocument: (projectId: string, documentId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, { method: 'DELETE' }),

  // ── Product/Service description input ──

  getProductContext: (projectId: string) =>
    fetchApi<{ context: ProductContext }>(`/projects/${projectId}/product-context`),

  updateProductContext: (projectId: string, patch: Partial<ProductContext>) =>
    fetchApi<{ context: ProductContext }>(`/projects/${projectId}/product-context`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  productContextInterview: (projectId: string, body: {
    message: string;
    history?: { role: 'user' | 'assistant'; content: string }[]
    response_language?: string
  }) =>
    fetchApi<ProductInterviewTurnResponse>(`/projects/${projectId}/product-context/interview`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Async: returns a job_id that the caller polls via getJobStatus.
  autofillPrfaqQuestions: (projectId: string, body: {
    feature_idea?: string;
    title?: string;
    response_language?: string
  }) =>
    fetchApi<{ answers: string[] }>(`/projects/${projectId}/prfaq-autofill`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  suggestResearchQuestions: (projectId: string, body: { response_language?: string } = {}) =>
    fetchApi<{ suggestions: Array<{ title: string; question: string }> }>(
      `/projects/${projectId}/research/suggest-questions`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  // NOT `DocType`, and its agreement with that union today is coincidence rather
  // than a floor: this is a DIFFERENT route (.../documents/suggest-brief) whose
  // `doc_type` only picks a prompt label, with anything unrecognised falling back to
  // 'PRD' (`projects.suggest_document_brief`). So it may legitimately fall behind a
  // widening of the document route — the cost is one prompt labelled PRD instead of
  // a new type's name, not a refused request. Binding it to `GENERATED_DOC_TYPES`
  // would instead make widening THIS route fail a test named after the other one.
  // If it is ever pinned it wants its own constant and its own rationale (#381).
  suggestDocumentBrief: (projectId: string, body: { doc_type?: 'prd' | 'prfaq'; response_language?: string } = {}) =>
    fetchApi<{ title: string; feature_idea: string }>(
      `/projects/${projectId}/documents/suggest-brief`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  buildPrototype: (projectId: string, body: {
    response_language?: string;
    title?: string;
    // Feedback-driven regeneration: revise an existing prototype centered on
    // this feedback while still honoring the PRD/PR-FAQ.
    feedback?: string;
    base_prototype_id?: string;
    // Which documents to build from. Omitted or '' means the newest of that type,
    // which is what every caller did before these existed. An id that does not
    // name a document of that type IN THIS PROJECT is rejected with a 4xx — the
    // API deliberately does not fall back to the newest, because a build against
    // a document the user did not choose is invisible in the result.
    source_prd_id?: string;
    source_prfaq_id?: string;
    // Optional extra grounding, chosen per build rather than remembered per
    // project. Omitted means today's behaviour exactly: the generator adds a
    // prompt section only for what is asked for.
    use_product_context?: boolean;
    // `selected_research_ids` is only read when `use_research` is true, and it is
    // research-only on purpose — the shared reference-document path keeps just the
    // first three of a selection, and research sorts last, so a general picker
    // drops exactly the thing this field exists to include. Ids are validated
    // against `RESEARCH#{id}` in this project; one that names nothing is a 4xx.
    use_research?: boolean;
    selected_research_ids?: string[];
    // Visual grounding: uploaded IMAGE product docs whose extracted design
    // description the generator injects, so the prototype takes its palette and
    // layout from the mockup instead of the default theme.
    //
    // There is NO `use_visuals` companion, unlike the research pair above: a
    // non-empty list is itself the request. A flag beside a list would admit a
    // "flag on, empty list" state that means nothing and a "flag off, ids present"
    // state that only a convention could resolve. Consequence: these ids are
    // validated whenever they are sent — there is no "off" for the check to skip —
    // so an id that does not name a product doc IN THIS PROJECT is a 4xx, and at
    // most `MAX_SELECTED_PRODUCT_DOC_IDS` of them may be named. Order is
    // precedence: where two visuals disagree, the generator's prompt prefers the
    // first.
    selected_product_doc_ids?: string[];
  }) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/build-prototype`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  generateProductReport: (projectId: string, body: { response_language?: string; title?: string }) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/product-report`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listProductDocs: (projectId: string) =>
    fetchApi<{ docs: ProductDoc[] }>(`/projects/${projectId}/product-docs`),

  createProductDocUploadUrl: (projectId: string, body: {
    filename: string;
    content_type: string;
    size_bytes: number
  }) =>
    fetchApi<{
      doc_id: string;
      presigned_url: string;
      headers: Record<string, string>
    }>(`/projects/${projectId}/product-docs/upload-url`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteProductDoc: (projectId: string, docId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/product-docs/${docId}`, { method: 'DELETE' }),

  /**
   * GET /projects/{project_id}/autoseed
   *
   * Returns the same autoseed payload as the Bearer-token MCP route, but is
   * authorised by the user's existing Cognito session — so it requires no API
   * token. Card 1 ("Export") in the Export / MCP tab wires its copy button to
   * this route.
   *
   * The backend helper _build_steering_file already injects the project's
   * kiro_export_prompt into the payload as a "## Custom Instructions" section,
   * server-side, so the response already has the template baked in.
   */
  autoseedProject: (projectId: string, params: {
    personaIds?: string[]
    documentIds?: string[]
  } = {}) => {
    const searchParams = new URLSearchParams()
    if ((params.personaIds?.length ?? 0) > 0) {
      searchParams.set('persona_ids', (params.personaIds ?? []).join(','))
    }
    if ((params.documentIds?.length ?? 0) > 0) {
      searchParams.set('document_ids', (params.documentIds ?? []).join(','))
    }
    const qs = searchParams.toString()
    const path = qs === '' ? `/projects/${projectId}/autoseed` : `/projects/${projectId}/autoseed?${qs}`
    return fetchApi<{ project: Record<string, unknown>; files: Array<{ path: string; content: string }> }>(path)
  },
}

// 🔑 The pin on `generateDocument`'s request-body parameter: it must admit EXACTLY
// `GenerateDocumentBody`, in both directions. `test_doc_type_lockstep.py` keeps this
// block present, since deleting it compiles cleanly.
//
// Needed because this method is the TERMINAL consumer of `data` — it is only spread
// into `JSON.stringify`, so the annotation is compared against nothing and any
// widening of it type-checks on its own. Measured, both spellings:
//   * `data: { doc_type: 'prd' | 'prfaq' | 'onepager', ... }` — the plain respelling;
//   * `data: Omit<GenerateDocumentBody, 'doc_type'>
//        & { doc_type: GenerateDocumentBody['doc_type'] | 'onepager' }` — which USES
//     the shared name, so neither `noUnusedLocals` nor a text check for the name sees
//     it.
// Both exited `tsc` 0 and sent a value the route 400s.
//
// ⚠️ This replaced a `satisfies GenerateDocumentBody` clause inside the method body,
// which was equivalent for the compiler but had to be pinned BY LOCATION from
// Python: a whole-file text check passed with the clause moved to an unrelated
// helper, and narrowing the search to the slice before the next method still passed
// with the clause in a NEW method inserted into that slice — measured, `tsc` exit 0
// and every lockstep test green while the axis was reopened. A comparison against
// the method's own type has no location to migrate to, so the text guard, its two
// method-name markers and their ordering assumption all went with it.
//
// `Parameters<...>[1]` reads the parameter off the declaration rather than restating
// it, so this cannot drift from the signature it pins. Equality in both directions
// for the same reason as `DocTypeFieldIsExactlyTheUnion`: a one-way `extends` passes
// on a NARROWED parameter, which is the "capability nobody can reach" half of this
// contract's drift.
//
// Each declaration below is on ONE line, with its comparison applied inline: the
// lockstep test requires the source to spell `SignatureMustMatch<BothWays<`, and
// wrapping puts a newline between the two so the substring goes absent.
type SignatureMustMatch<Verdict extends true> = Verdict
// The parameter as DECLARED, read off the method so this cannot restate it.
type DeclaredGenerateDocumentBody = Parameters<typeof projectsApi.generateDocument>[1]
export type GenerateDocumentTakesTheSharedBody = SignatureMustMatch<BothWays<DeclaredGenerateDocumentBody, GenerateDocumentBody>>
// The non-vacuity controls, in the convention the lockstep tests use for their own:
// `SignatureMustMatch<BothWays<...>>` is also satisfied by a `BothWays` that
// degenerates to `true`, which would report success while comparing nothing.
//
// WIDENED side — a body with one extra member must NOT compare equal.
type SignatureMustDiffer<Verdict extends false> = Verdict
export type GenerateDocumentSignaturePinWouldSeeDrift = SignatureMustDiffer<BothWays<DeclaredGenerateDocumentBody, GenerateDocumentBody & { not_in_the_body: true }>>
// NARROWED side — refuses a `BothWays` collapsed to its ONE-WAY form, which the
// control above cannot detect: a widened left side fails `[Left] extends [Right]`
// under either form, so the two are indistinguishable to it (see the ⚠️ note on
// `BothWays` in ./types). `never` is assignable to the body, so a one-way comparison
// calls this `true` and the line becomes a TS2344.
export type GenerateDocumentSignaturePinWouldSeeNarrowing = SignatureMustDiffer<BothWays<never, GenerateDocumentBody>>
