// Projects API - extracted from client.ts to reduce file size
// Uses shared fetchApi from client.ts for consistent 401 retry + token refresh
import { del, post, put } from './requestKit'
import { fetchApi } from './client'
import { getDateBasisBodyParams } from './baseUrl'
import {
  normalizeDocumentVersions, normalizeMemberCandidates, normalizeProject, normalizeProjectDetail,
  normalizeProjectDetailBatch, normalizeProjectDocument, normalizeProjectList, normalizeProjectMember,
  normalizeProjectMembers,
} from './projectDetailSchema'
import type { DocumentVersion } from './projectDetailSchema'
import { asRecord } from './wireRecord'
import { isAssistJobType, runAssistJob } from './assistJobs'
import {
  parseDocumentBrief, parsePrfaqAnswers, parseRegeneratedAvatar, parseResearchSuggestions,
} from './assistResults'
import { normalizeAddPersonaNoteResponse } from './personaNoteSchema'
import type { AddPersonaNoteResponse } from './personaNoteSchema'
import type { AiDraftFilters } from './aiDraft'
import type {
  ProjectDocument,
  // The document-generation request body; see its declaration for why it is a
  // named type rather than an object literal spelled out here. `BothWays` comes with
  // it for the signature pin at the foot of this file.
  GenerateDocumentBody,
  BothWays,
} from './types'
import type {
  Project,
  ProjectDetail,
  ProjectPersona,
  ProjectJob,
  ProductContext,
  ProductDoc,
  ProjectVisibility,
  ProjectMemberRole,
  ProjectMembersResponse,
  ProjectMemberCandidate,
  CreateProjectBody,
} from './projectTypes'

/** = MAX_PROJECT_DETAIL_BATCH in lambda/api/projects.py (the server answers 400 above it). */
export const MAX_PROJECT_DETAIL_BATCH = 200

/** A JSON POST's request init (`post(...)` is what check-mock-coverage reads as POST). */

/**
 * A project assist job (api/assistJobs): `start` POSTs and gets 202 + a job id,
 * polled through the project job read (`getJobStatus`, validated by the poller);
 * the job's `result` is the body the route used to answer synchronously, read by
 * `parse`.
 */
function projectAssist<T>(projectId: string, start: () => Promise<unknown>, parse: (result: unknown) => T): Promise<T> {
  return runAssistJob(start, (jobId) => projectsApi.getJobStatus(projectId, jobId), parse)
}

/** The jobs list without assist jobs (the API leaves them out; this is the belt to that). */
function withoutAssistJobs(answer: { success: boolean; jobs: ProjectJob[] }) {
  return Array.isArray(answer.jobs)
    ? { ...answer, jobs: answer.jobs.filter((job) => !isAssistJobType(job.job_type)) }
    : answer
}

export const projectsApi = {
  getProjects: async (): Promise<{ projects: Project[] }> => {
    const raw = await fetchApi<unknown>('/projects')
    return normalizeProjectList(raw)
  },

  createProject: async (data: CreateProjectBody): Promise<{ success: boolean; project: Project | null }> => {
    const raw = await fetchApi<unknown>('/projects', post(data))
    const record = asRecord(raw)
    return { success: record?.success === true, project: normalizeProject(record?.project) }
  },

  getProject: async (id: string): Promise<ProjectDetail> => {
    const raw = await fetchApi<unknown>(`/projects/${id}`)
    return normalizeProjectDetail(raw)
  },

  /**
   * Many projects' details (without personas) in one `GET /projects?ids=…` per
   * MAX_PROJECT_DETAIL_BATCH ids — one request for any board one team prioritises.
   * Only projects the caller can view come back; the rest are simply absent.
   */
  getProjectDetails: async (ids: readonly string[]): Promise<ProjectDetail[]> => {
    const chunks = Array.from(
      { length: Math.ceil(ids.length / MAX_PROJECT_DETAIL_BATCH) },
      (_, index) => ids.slice(index * MAX_PROJECT_DETAIL_BATCH, (index + 1) * MAX_PROJECT_DETAIL_BATCH),
    )
    const pages = await Promise.all(chunks.map(async (chunk) => {
      const query = new URLSearchParams({ ids: chunk.join(',') })
      return normalizeProjectDetailBatch(await fetchApi<unknown>(`/projects?${query.toString()}`))
    }))
    return pages.flat()
  },

  updateProject: (id: string, data: Partial<Project>) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, put(data)),

  deleteProject: (id: string) =>
    fetchApi<{ success: boolean }>(`/projects/${id}`, del()),

  // ── Sharing (see the HTTP contract in lambda/shared/project_access.py) ──
  setVisibility: (id: string, visibility: ProjectVisibility) =>
    fetchApi<{ success: boolean; visibility: ProjectVisibility }>(`/projects/${id}/visibility`, put({ visibility })),

  getMembers: async (id: string): Promise<ProjectMembersResponse> => {
    const raw = await fetchApi<unknown>(`/projects/${id}/members`)
    return normalizeProjectMembers(raw)
  },

  searchMemberCandidates: async (id: string, q: string): Promise<ProjectMemberCandidate[]> => {
    const raw = await fetchApi<unknown>(`/projects/${id}/members/candidates?${new URLSearchParams({ q })}`)
    return normalizeMemberCandidates(raw)
  },

  addMember: async (id: string, sub: string, role: ProjectMemberRole) => {
    const raw = await fetchApi<unknown>(`/projects/${id}/members`, post({ sub, role }))
    return { member: normalizeProjectMember(asRecord(raw)?.member) }
  },

  updateMemberRole: async (id: string, sub: string, role: ProjectMemberRole) => {
    const raw = await fetchApi<unknown>(`/projects/${id}/members/${encodeURIComponent(sub)}`, put({ role }))
    return { member: normalizeProjectMember(asRecord(raw)?.member) }
  },

  removeMember: (id: string, sub: string) =>
    fetchApi<{ success: boolean }>(`/projects/${id}/members/${encodeURIComponent(sub)}`, del()),

  transferOwnership: (id: string, sub: string) =>
    fetchApi<{ success: boolean }>(`/projects/${id}/owner`, post({ sub })),

  generatePersonas: (projectId: string, filters?: {
    sources?: string[]
    categories?: string[]
    sentiments?: string[]
    persona_count?: number
    custom_instructions?: string
    days?: number
    response_language?: string
    /** true adds next to the project's personas; false/absent replaces them (#353). */
    keep_existing_personas?: boolean
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
    }>(`/projects/${projectId}/personas/generate`, post({ ...getDateBasisBodyParams(), ...filters })),

  updatePersona: (projectId: string, personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, put(data)),

  deletePersona: (projectId: string, personaId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/personas/${personaId}`, del()),

  /**
   * A new avatar image for one persona (an assist job: the image model can take
   * longer than the gateway allows). Each image is stored under its own key, so
   * the answer's signed URL is never the cached old one. `avatar_url` is null
   * when the answer carries none (signing unavailable).
   */
  regeneratePersonaAvatar: (projectId: string, personaId: string): Promise<{ avatar_url: string | null }> =>
    projectAssist(projectId, () => fetchApi<unknown>(`/projects/${projectId}/personas/${personaId}/regenerate-avatar`, post()), parseRegeneratedAvatar),

  addPersonaNote: async (projectId: string, personaId: string, body: { text: string; author?: string }): Promise<AddPersonaNoteResponse> => {
    const raw = await fetchApi<unknown>(`/projects/${projectId}/personas/${personaId}/notes`, post(body))
    return normalizeAddPersonaNoteResponse(raw)
  },

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
    }>(`/projects/${projectId}/personas/import`, post(data)),

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
    }>(`/projects/${projectId}/research`, post({ ...getDateBasisBodyParams(), ...data })),

  // Keep this signature on ONE line, and keep `data` taking the shared type by name:
  // test_doc_type_lockstep.py matches it as exact text, and requires EVERY declaration
  // of generateDocument to take `GenerateDocumentBody`. That is a ratio rather than a
  // substring search because a substring was satisfied by an unrelated occurrence —
  // and by a decoy copy of this signature — while the real parameter was respelled as
  // a structurally identical inline literal. The pin at the foot of this file cannot
  // see that one either: an identical shape compares EQUAL (issue #381).
  generateDocument: (projectId: string, data: GenerateDocumentBody) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/document`, post({ ...getDateBasisBodyParams(), ...data })),

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
    }>(`/projects/${projectId}/documents/merge`, post(data)),

  getJobStatus: (projectId: string, jobId: string) =>
    fetchApi<ProjectJob>(`/projects/${projectId}/jobs/${jobId}`),

  getJobs: (projectId: string) =>
    fetchApi<{
      success: boolean;
      jobs: ProjectJob[]
    }>(`/projects/${projectId}/jobs`).then(withoutAssistJobs),

  dismissJob: (projectId: string, jobId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/jobs/${jobId}`, del()),

  createDocument: (projectId: string, data: {
    title: string;
    content: string;
    document_type?: 'custom'
  }) =>
    fetchApi<{
      success: boolean;
      document: ProjectDocument
    }>(`/projects/${projectId}/documents`, post(data)),

  /**
   * A PR/FAQ or PRD written by hand: the next version of its series, `origin: human`
   * (docs/ways-of-working.md). No `content` = the server's blank template; `create_id`
   * makes a retried click one document.
   */
  startHandWrittenDocument: (projectId: string, data: {
    document_type: 'prfaq' | 'prd';
    title: string;
    create_id: string;
  }) =>
    fetchApi<{
      success: boolean;
      document: ProjectDocument
    }>(`/projects/${projectId}/documents`, post(data)),

  /**
   * Save an edit. It is a NEW version (a PRD / PR-FAQ edit is the next version of
   * its series, with a new id); the answer's `document` is the saved one. Pass a
   * fresh `edit_id` per save so a retried request replays instead of duplicating,
   * and the `expected_revision` the editor loaded (`documentRevision`) so a save
   * over someone else's newer one is a 409 rather than a silent overwrite.
   */
  updateDocument: async (projectId: string, documentId: string, data: {
    title?: string;
    content?: string;
    edit_id?: string;
    expected_revision?: number
  }): Promise<{ success: boolean; document: ProjectDocument | null }> => {
    const raw = await fetchApi<unknown>(`/projects/${projectId}/documents/${documentId}`, put(data))
    const record = asRecord(raw)
    return { success: record?.success === true, document: normalizeProjectDocument(record?.document) }
  },

  /** Every version of a document, newest first, with content (open / compare). */
  getDocumentVersions: async (projectId: string, documentId: string): Promise<DocumentVersion[]> =>
    normalizeDocumentVersions(await fetchApi<unknown>(`/projects/${projectId}/documents/${documentId}/versions`)),

  /** Restore = a NEW version carrying `versionId`'s content; nothing is rewritten. */
  restoreDocumentVersion: async (projectId: string, documentId: string, versionId: string, editId: string): Promise<ProjectDocument | null> => {
    const raw = await fetchApi<unknown>(
      `/projects/${projectId}/documents/${documentId}/versions/${encodeURIComponent(versionId)}/restore`,
      post({ edit_id: editId }),
    )
    return normalizeProjectDocument(asRecord(raw)?.document)
  },

  deleteDocument: (projectId: string, documentId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/documents/${documentId}`, del()),

  // ── Product/Service description input ──

  getProductContext: (projectId: string) =>
    fetchApi<{ context: ProductContext }>(`/projects/${projectId}/product-context`),

  updateProductContext: (projectId: string, patch: Partial<ProductContext>) =>
    fetchApi<{ context: ProductContext }>(`/projects/${projectId}/product-context`, put(patch)),

  // An assist job like the helpers below: the route answers 202 with a job id and
  // this polls the project job read until the answers (the job's `result`) are in.
  // `title`, `feature_idea` and `answers` are what the author typed: the route keeps
  // them as their intent (rewrites typed answers, drafts the empty ones). Caps → 400:
  // AI_DRAFT_LIMITS (lambda/shared/draft_intent.py).
  autofillPrfaqQuestions: (projectId: string, body: {
    feature_idea?: string;
    title?: string;
    answers?: string[];
    filters?: AiDraftFilters;
    response_language?: string
  }): Promise<{ answers: string[] }> =>
    projectAssist(projectId, () => fetchApi<unknown>(`/projects/${projectId}/prfaq-autofill`, post(body)), parsePrfaqAnswers),

  suggestResearchQuestions: (projectId: string, body: { response_language?: string } = {}): Promise<{ suggestions: Array<{ title: string; question: string }> }> =>
    projectAssist(projectId, () => fetchApi<unknown>(`/projects/${projectId}/research/suggest-questions`, post(body)), parseResearchSuggestions),

  // NOT `DocType`, and its agreement with that union today is coincidence rather
  // than a floor: this is a DIFFERENT route (.../documents/suggest-brief) whose
  // `doc_type` only picks a prompt label, with anything unrecognised falling back to
  // 'PRD' (`projects.suggest_document_brief`). So it may legitimately fall behind a
  // widening of the document route — the cost is one prompt labelled PRD instead of
  // a new type's name, not a refused request. Binding it to `GENERATED_DOC_TYPES`
  // would instead make widening THIS route fail a test named after the other one.
  // If it is ever pinned it wants its own constant and its own rationale (#381).
  //
  // `title` / `feature_idea` are what the author typed: non-empty text is rewritten and
  // expanded, never replaced; both empty drafts from the feedback (`filters`, else the
  // project's saved filters).
  suggestDocumentBrief: (projectId: string, body: {
    doc_type?: 'prd' | 'prfaq';
    title?: string;
    feature_idea?: string;
    filters?: AiDraftFilters;
    response_language?: string
  } = {}): Promise<{ title: string; feature_idea: string }> =>
    projectAssist(projectId, () => fetchApi<unknown>(`/projects/${projectId}/documents/suggest-brief`, post(body)), parseDocumentBrief),

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
    // The company design system (Knowledge → Company → Design system). Omitted means
    // ON — the generator always read it before the build dialog offered the choice —
    // so only `false` leaves it out of the prompt.
    use_design_system?: boolean;
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
    }>(`/projects/${projectId}/build-prototype`, post(body)),

  generateProductReport: (projectId: string, body: { response_language?: string; title?: string }) =>
    fetchApi<{
      success: boolean;
      job_id: string;
      status: string;
      message: string
    }>(`/projects/${projectId}/product-report`, post(body)),

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
    }>(`/projects/${projectId}/product-docs/upload-url`, post(body)),

  deleteProductDoc: (projectId: string, docId: string) =>
    fetchApi<{ success: boolean }>(`/projects/${projectId}/product-docs/${docId}`, del()),
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
// `Parameters<...>[1]` reads the parameter off the METHOD rather than restating it, so
// the left side of this comparison is whatever the signature actually declares.
// Applied INLINE below rather than through an intermediate alias: an alias is a second
// place the left side can be respelled, and repointing one at `GenerateDocumentBody`
// made the pin compare the interface to itself — trivially equal forever, with both
// controls still green because they read through the same alias. Measured: `tsc` exit
// 0, every lockstep test green, and a caller sending a value the route 400s.
//
// Equality in both directions for the same reason as `DocTypeFieldIsExactlyTheUnion`:
// a one-way `extends` passes on a NARROWED parameter, which is the "capability nobody
// can reach" half of this contract's drift.
//
// Each declaration below is on ONE line, with its comparison applied inline: the
// lockstep test pins each as an EXACT string, so wrapping puts a newline inside what
// it looks for. See TYPE_LEVEL_PINS in lambda/api/test/test_doc_type_lockstep.py.
//
// One verdict helper, no `SignatureMustDiffer` companion — see the 🔑 note on
// `MustBeTrue` in ./types: the controls assert their verdict by expecting THIS helper's
// error, so dropping `extends true` makes each `@ts-expect-error` unused (TS2578)
// instead of silently disabling every control at once.
type SignatureMustMatch<Verdict extends true> = Verdict
export type GenerateDocumentTakesTheSharedBody = SignatureMustMatch<BothWays<Parameters<typeof projectsApi.generateDocument>[1], GenerateDocumentBody>>
// The non-vacuity controls. `SignatureMustMatch<BothWays<...>>` is also satisfied by a
// `BothWays` that degenerates to `true` or collapses to one-way, each of which reports
// success while comparing less than it claims. Both are INVERTED assertions: the
// comparison must NOT hold, so the helper must reject it and `@ts-expect-error`
// consumes that error — self-checking, since a comparison that starts holding leaves
// the directive unused.
//
// WIDENED side — a body with one extra member must NOT compare equal.
// @ts-expect-error the declared parameter must NOT equal a body with an extra member
export type GenerateDocumentSignaturePinWouldSeeDrift = SignatureMustMatch<BothWays<Parameters<typeof projectsApi.generateDocument>[1], GenerateDocumentBody & { not_in_the_body: true }>>
// NARROWED side — refuses a `BothWays` collapsed to its ONE-WAY form, which the
// control above cannot detect: a widened left side fails `[Left] extends [Right]`
// under either form, so the two are indistinguishable to it (see the ⚠️ note on
// `BothWays` in ./types). The declared parameter is narrower than a body whose members
// are all optional, so a one-way comparison calls this `true`, the directive goes
// unused and the line becomes a TS2578; two-way, it is `false` as required.
//
// 🔑 Left side reads `Parameters<...>[1]`, the same operand as the pin, rather than the
// `never` this once used. `never` discriminates the two forms just as well, but it
// mentions nothing about this method — so it was a second detector of a collapse in the
// SHARED `BothWays` (already caught once in ./types) rather than a control on THIS pin,
// and deleting it left the collapse detected only by the other file. `Partial<...>` is
// derived from the body, so it names no member and cannot go stale when the contract is
// widened.
// @ts-expect-error the declared parameter must NOT equal a body of optional members
export type GenerateDocumentSignaturePinWouldSeeNarrowing = SignatureMustMatch<BothWays<Parameters<typeof projectsApi.generateDocument>[1], Partial<GenerateDocumentBody>>>
