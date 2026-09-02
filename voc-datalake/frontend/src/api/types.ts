// API Types - extracted from client.ts to reduce file size

// The derivation contract lives with its schema and resolver, so the runtime
// validation and the declared type cannot drift apart.
import type { DocumentDerivation } from './derivation'
// The credential vocabulary lives with its schema for the same reason: the
// declared type and the runtime validation cannot drift apart.
import type { McpScope, ReadReach } from './mcpTokenSchema'

export interface FeedbackItem {
  feedback_id: string
  source_id: string
  source_platform: string
  source_channel: string
  /** Ingestion-path provenance, e.g. 'manual', 'csv_upload', 'json_upload'. Absent for sources that don't send it. */
  ingestion_method?: string
  source_url?: string
  brand_name: string
  source_created_at: string
  processed_at: string
  original_text: string
  original_language: string
  normalized_text?: string
  rating?: number
  category: string
  subcategory?: string
  journey_stage: string
  sentiment_label: string
  sentiment_score: number
  urgency: string
  impact_area: string
  problem_summary?: string
  problem_root_cause_hypothesis?: string
  direct_customer_quote?: string
  persona_name?: string
  persona_type?: string
}

/**
 * Which date the `days` window applies to on time-filtered endpoints.
 *
 * - 'imported': when the item entered the data lake (historical default)
 * - 'review':   when the customer originally wrote the feedback
 *               (`source_created_at`) — excludes old reviews that were only
 *               imported recently
 */
export type DateBasis = 'imported' | 'review'

/**
 * Filter shape shared by feedback list endpoints.
 *
 * Used by `/feedback`, `/feedback/urgent`, and `/feedback/search`. Each filter
 * narrows the result set independently; combine them via AND on the server.
 */
export interface FeedbackFilters {
  days?: number
  date_basis?: DateBasis
  source?: string
  category?: string
  sentiment?: string
}

/**
 * Query parameters for the paginated `/feedback` list endpoint.
 *
 * Pagination is offset-based within a candidate window (see backend
 * `list_feedback` for window semantics). `offset` of 0 is the first page.
 */
export interface FeedbackListParams extends FeedbackFilters {
  limit?: number
  offset?: number
}

/**
 * Response envelope for the paginated `/feedback` list endpoint.
 *
 * - `count` is the size of the returned page (0..limit).
 * - `total` is the size of the filtered candidate window — `hasMore` should be
 *   computed as `loaded < total`, not `count < limit`.
 * - `offset` and `limit` echo the applied request parameters.
 * - `is_partial_window` is true when the candidate window was truncated by the
 *   backend's MAX_FEEDBACK_OFFSET cap, meaning more matching records may exist
 *   beyond what was counted. UI should treat `total` as a lower bound in that
 *   case.
 */
export interface FeedbackListResponse {
  count: number
  total: number
  offset: number
  limit: number
  is_partial_window: boolean
  items: FeedbackItem[]
}

/**
 * Response envelope for `/feedback/urgent`. Not paginated — returns up to
 * `limit` items in one shot.
 */
export interface UrgentFeedbackResponse {
  count: number
  items: FeedbackItem[]
}

export interface MetricsSummary {
  period_days: number
  total_feedback: number
  avg_sentiment: number
  urgent_count: number
  /**
   * True when the window could not be read in full, so the counts are a lower
   * bound rather than a total. THE canonical statement of this flag on the
   * frontend — the sibling breakdown types point here rather than repeat it.
   *
   * Three independent reasons, reported under one name because the caller's
   * response to all three is the same:
   *
   * - the raw-item scan was truncated (review-date basis, or a source filter on
   *   a very large window);
   * - a metric partition read stopped before the end of its window;
   * - the requested window is wider than aggregates are retained for (~90 days),
   *   so the older rows are already deleted and no complete answer exists.
   *
   * Optional only for backward compatibility with a deployed API that omitted it
   * on the aggregates path; treat an absent value as `false` (which is what
   * `?? false` at the call site does) rather than as unknown.
   */
  is_partial?: boolean
  daily_totals: {
    date: string;
    count: number
  }[]
  daily_sentiment: {
    date: string;
    avg_sentiment: number;
    count: number
  }[]
}

export interface SentimentBreakdown {
  period_days: number
  total: number
  /** See {@link MetricsSummary.is_partial} — same flag, same three reasons. */
  is_partial?: boolean
  breakdown: Record<string, number>
  percentages: Record<string, number>
}

export interface CategoryBreakdown {
  period_days: number
  /** See {@link MetricsSummary.is_partial} — same flag, same three reasons. */
  is_partial?: boolean
  categories: Record<string, number>
}

export interface SourceBreakdown {
  period_days: number
  /** See {@link MetricsSummary.is_partial} — same flag, same three reasons. */
  is_partial?: boolean
  sources: Record<string, number>
}

/**
 * Response envelope for `/metrics/personas`.
 *
 * Named rather than inlined at the call site so the route's `is_partial` has
 * somewhere to be declared: an inline generic is where a field goes to be
 * invisible, which is the same defect this flag exists to close one layer down.
 */
export interface PersonaBreakdown {
  period_days: number
  /** See {@link MetricsSummary.is_partial} — same flag, same three reasons. */
  is_partial?: boolean
  /**
   * True when `personas` carries at least one bucket the current axis cannot write —
   * i.e. a row written before the dimension moved to `persona_type`, which is free
   * text or a capitalised `Unknown`. The counts are correct either way; the flag says
   * the KEY SPACE is mid-transition, which resolves itself once no pre-move aggregate
   * row survives its 90-day TTL.
   *
   * Published on every branch, false included, for the reason `is_partial` is: a
   * reader cannot tell an absent flag from a false one. A consumer rendering this
   * dimension during the transition should expect keys outside the archetype set and
   * must not merge them into `unknown` — see `has_legacy_persona_buckets` in
   * `lambda/shared/feedback.py` for why that would destroy information.
   */
  has_legacy_persona_buckets?: boolean
  /**
   * Keys are enrichment-contract ARCHETYPE CODES, not display labels:
   * `existing_customer | prospect | churn_risk | advocate | unknown`
   * (`PERSONA_ARCHETYPES` in `lambda/shared/feedback.py`, which closes the axis so
   * anything outside the set is counted as `unknown`).
   *
   * So whoever first renders this dimension must MAP them, through i18n like every
   * other user-facing label — printing a key would put `churn_risk` on screen. They
   * are codes on purpose: the axis used to bucket on a free-text `persona_name`, and
   * a caller grouping by a dimension can enumerate a contract enum and cannot
   * enumerate free text. During the ~90 days aggregate rows written before the move
   * survive, this map can also carry their legacy free-text keys and a separate
   * `Unknown` — see the transition note at `PERSONA_UNKNOWN`.
   */
  personas: Record<string, number>
}

export interface IntegrationStatus {
  webscraper: {
    configured: boolean
    webhook_url: string
    last_webhook_received?: string
    credentials_set: string[]
  }
  [key: string]: {
    configured: boolean
    webhook_url?: string
    last_webhook_received?: string
    credentials_set: string[]
  }
}

export interface ScraperConfig {
  id: string
  name: string
  enabled: boolean
  base_url: string
  urls: string[]
  frequency_minutes: number
  extraction_method?: 'css' | 'jsonld'
  template?: string
  container_selector: string
  text_selector: string
  title_selector?: string
  rating_selector?: string
  rating_attribute?: string
  date_selector?: string
  author_selector?: string
  link_selector?: string
  pagination: {
    enabled: boolean
    param: string
    max_pages: number
    start: number
  }
  last_run?: string
  items_found?: number
}

export interface ScraperTemplate {
  id: string
  name: string
  description: string
  icon: string
  extraction_method: 'css' | 'jsonld'
  url_pattern: string
  url_placeholder: string
  supports_pagination: boolean
  pagination: {
    enabled: boolean
    param: string
    start: number
    max_pages: number
  }
  config: Partial<ScraperConfig>
}

export interface EntitiesResponse {
  period_days: number
  feedback_count: number
  /**
   * See {@link MetricsSummary.is_partial} — same flag, same three reasons.
   *
   * Describes the COUNTS (`feedback_count` and the category/source/persona maps).
   * `entities.issues` is a deliberate sample on both of the route's paths — the
   * newest rows of at most seven days, capped at `limit` — so it is not what this
   * flag is about, and folding it in would make the flag true on nearly every
   * call and therefore worth nothing.
   */
  is_partial?: boolean
  /** See {@link PersonaBreakdown.has_legacy_persona_buckets} — the same flag about the
   *  same axis, on this route's `entities.personas` map. */
  has_legacy_persona_buckets?: boolean
  entities: {
    keywords: Record<string, number>
    categories: Record<string, number>
    issues: Record<string, number>
    personas: Record<string, number>
    sources: Record<string, number>
  }
}

export interface ProjectJob {
  success?: boolean
  job_id: string
  job_type: 'research' | 'generate_personas' | 'generate_prd' | 'generate_prfaq' | 'generate_product_report' | 'build_prototype' | 'merge_documents' | 'import_persona'
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  current_step?: string
  created_at: string
  updated_at?: string
  completed_at?: string
  error?: string
  result?: {
    document_id?: string
    persona_id?: string
    title?: string
    personas?: ProjectPersona[]
    /**
     * How the generation was grounded (issue #231).
     *
     * `feedback_items_used` is the number of feedback records that actually
     * reached the model, which is smaller than `feedback_count` (the number
     * read from the data lake) whenever `context_truncated` is true. Reporting
     * only the count read would overstate the evidence behind the result
     * exactly when the corpus was too large to fit. `fetch_limit_reached` is a
     * separate loss: `feedback_count` is itself bounded by `fetch_limit`, so
     * records the filters matched beyond it were never read at all.
     *
     * Read through `parseJobGrounding` (api/jobGroundingSchema.ts), never
     * directly: these arrive from a DynamoDB job record, so the declared types
     * are what the API intends, not what the wire guarantees.
     */
    metadata?: {
      feedback_count?: number
      feedback_items_used?: number
      context_truncated?: boolean
      fetch_limit_reached?: boolean
      fetch_limit?: number
    }
  }
}

export interface ProjectPersona {
  persona_id: string
  name: string
  tagline: string
  created_at: string
  confidence?: 'high' | 'medium' | 'low'
  feedback_count?: number
  avatar_url?: string
  avatar_prompt?: string
  // Section 1: Identity & Demographics
  identity?: {
    age_range?: string
    location?: string
    occupation?: string
    income_bracket?: string
    education?: string
    family_status?: string
    bio?: string
  }
  // Section 2: Goals & Motivations
  goals_motivations?: {
    primary_goal?: string
    secondary_goals?: string[]
    success_definition?: string
    underlying_motivations?: string[]
  }
  // Section 3: Pain Points & Frustrations
  pain_points?: {
    current_challenges?: string[]
    blockers?: string[]
    workarounds?: string[]
    emotional_impact?: string
  }
  // Section 4: Behaviors & Habits
  behaviors?: {
    current_solutions?: string[]
    tools_used?: string[]
    activity_frequency?: string
    tech_savviness?: string
    decision_style?: string
  }
  // Section 5: Context & Environment
  context_environment?: {
    usage_context?: string
    devices?: string[]
    time_constraints?: string
    social_context?: string
    influencers?: string[]
  }
  // Section 6: Representative Quotes
  quotes?: Array<{
    text: string;
    context?: string
  }>
  // Section 7: Scenario/User Story
  scenario?: {
    title?: string
    narrative?: string
    trigger?: string
    outcome?: string
  }
  // Section 8: Research Notes
  research_notes?: Array<string | {
    note_id?: string;
    text: string;
    author?: string;
    created_at?: string;
    tags?: string[]
  }>
  // Metadata
  supporting_evidence?: string[]
  source_breakdown?: Record<string, number>
}

// 🔑 The ONE declaration of what POST /projects/{id}/document accepts in
// `doc_type`. `projects_handler.GENERATED_DOC_TYPES` is pinned against THIS line by
// lambda/api/test/test_doc_type_lockstep.py, so widen both together or that test
// fails. Keep it a union of string LITERALS: the lockstep parser refuses a derived
// spelling (`typeof GENERATED_DOC_TYPES[number]`) rather than resolving it.
//
// It lives here, beside the other wire types, rather than in
// `pages/ProjectDetail/types.ts` where it was declared before: the route owns this
// contract, and `api/` importing from `pages/` inverted the layering. The document
// picker re-exports it from there (issue #381).
export type DocType = 'prd' | 'prfaq'

// The POST /projects/{id}/document request body, named so that BOTH
// `generateDocument` signatures — `projectsApi.ts` and the `client.ts` wrapper that
// forwards to it — reference one declaration instead of restating the shape.
//
// 🔑 Why a named type and not just `doc_type: DocType` in each signature: the
// `projectsApi` one is the TERMINAL consumer (its `data` is only spread into
// `JSON.stringify`), so widening its annotation inline is an assignability error
// NOWHERE — `tsc` accepts it and the request goes out with a value the route 400s.
// Only the shared name closes that, and `test_doc_type_lockstep.py` asserts both
// signatures still spell it.
//
// `doc_type` below is pinned to `DocType` by `DocTypeFieldIsExactlyTheUnion`, a few
// lines down. Referencing the union HERE is not self-enforcing: nothing had stopped
// this one field being respelled back to `'prd' | 'prfaq' | 'onepager'`, which was
// measured to leave `tsc`, `eslint` and the whole lockstep suite green while the
// route 400s the third value.
export interface GenerateDocumentBody {
  doc_type: DocType
  title: string
  feature_idea: string
  data_sources: {
    feedback: boolean;
    personas: boolean;
    documents: boolean;
    research: boolean
  }
  selected_persona_ids: string[]
  selected_document_ids: string[]
  feedback_sources: string[]
  feedback_categories: string[]
  days: number
  customer_questions?: string[]
  response_language?: string
}

// 🔑 The pin on `GenerateDocumentBody.doc_type`. What it guarantees, stated as the
// property it actually checks: that field admits EXACTLY the members of `DocType`,
// in both directions. Deleting this block compiles cleanly, so
// `test_the_type_level_pins_are_present` in
// lambda/api/test/test_doc_type_lockstep.py keeps these declarations present.
//
// ⚠️ It does NOT check that the field REFERENCES `DocType` — an earlier version of
// this comment said it did, and that was measured to be the opposite of the truth.
// `BothWays` is a structural comparison, so respelling the field `'prd' | 'prfaq'`
// — the same members, no reference to the union at all — passes it (verified: `tsc`
// exit 0, every lockstep test green). Set equality is the weaker property and it is
// the SUFFICIENT one: a same-member respelling is harmless today, and if `DocType`
// is later widened the stale field stops being equal to it and this line becomes a
// TS2344. So the drift this contract cares about is still caught at the moment it
// would be introduced; only the coincidence is tolerated, and never silently.
//
// Why the pin is needed at all — measured, not assumed. Every other guard around
// this contract stops one level further out:
//   * the lockstep test parses only the `export type DocType =` declaration above,
//     so it cannot see this interface;
//   * `GenerateDocumentTakesTheSharedBody` in `projectsApi.ts` compares that
//     method's PARAMETER to this interface, so a widened interface satisfies it by
//     construction;
//   * `noUnusedLocals` stays quiet, since `DocType` is still used by
//     `ProjectDocument` below.
// So respelling the field `'prd' | 'prfaq' | 'onepager'` was measured to exit `tsc`
// 0, pass all lockstep tests and lint clean, while a caller could then send a value
// the route 400s. That is the one edit the comments above direct a widener TO, which
// is why it gets a compiler check and not a third text assertion.
//
// A one-way `extends` would not do: `'prd'` extends `DocType`, so a NARROWED field
// (offering less than the route accepts — the "unreachable capability" half of the
// drift this contract is about) would pass. Hence equality in both directions.
// `[T] extends [U]` rather than `T extends U`: the bare form distributes over a
// union, which would compare member-by-member and accept a subset.
//
// ⚠️ WHAT PINS THE SECOND DIRECTION. A WIDENED-side control does not: a superset
// fails `[Left] extends [Right]` under the one-way form too, so the two forms are
// INDISTINGUISHABLE to it, and collapsing this type to `[Left] extends [Right]`
// was measured to leave `tsc` at exit 0 with every lockstep test green. Only a
// NARROWED-side control separates them, which is why each pin below has one as well
// (`...WouldSeeNarrowing`). Each compares its OWN pin's left operand against a wider
// type DERIVED from the right one, so it is `true` under a one-way comparison and
// `false` under this one, with no member spelled out to go stale.
//
// ⚠️ Not `Omit<...>`, which looks like the natural narrowing and detects nothing:
// measured, `Omit<GenerateDocumentBody, 'doc_type'>` is NOT assignable to the
// interface (it lacks a required property), so it is `false` under BOTH forms. A
// narrowed-FIELD shape such as `Omit<GenerateDocumentBody, 'doc_type'> &
// { doc_type: 'prd' }` does discriminate, but it names a member and so goes stale the
// moment the contract is widened.
//
// ⚠️ Nor a bare `never` on the left, which the signature control used to have. It
// discriminates the two forms perfectly well, but it mentions nothing about the thing
// being pinned — so it was really a second detector of a collapse in THIS shared
// helper (already reported once, here) rather than a control on that pin. Measured:
// deleting it left a one-way collapse reported only by this file. Reading the pin's
// own operand is what makes each control local to its pin.
export type BothWays<Left, Right> = [Left] extends [Right]
  ? ([Right] extends [Left] ? true : false)
  : false
// The ONE verdict helper. `Verdict extends true` is the whole assertion: applied to a
// comparison that came back `false`, the constraint is unsatisfied and the line is a
// TS2344.
//
// 🔑 There is deliberately no `MustBeFalse` companion. The controls below assert their
// verdict by applying THIS helper and expecting the error, via `@ts-expect-error`, so
// that dropping `extends true` cannot go unnoticed: with the constraint gone the
// controls stop erroring and each directive becomes an "unused '@ts-expect-error'"
// TS2578. A separate `MustBeFalse<Verdict extends false>` could not do that — it was
// measured that deleting BOTH constraints left `tsc` at exit 0 with every lockstep
// test green while the field below was widened, because a text check on the helpers'
// names is satisfied by their own declarations.
type MustBeTrue<Verdict extends true> = Verdict
// Each declaration below is written on ONE line. That is load-bearing rather than a
// formatting choice: the lockstep test pins each one as an EXACT string, so a wrapped
// declaration puts a newline inside what it is looking for. See TYPE_LEVEL_PINS in
// lambda/api/test/test_doc_type_lockstep.py for why it pins the whole declaration
// rather than a fragment of it.
//
// Exported only so `noUnusedLocals` cannot be what deletes them; nothing imports
// any of them, and nothing should.
export type DocTypeFieldIsExactlyTheUnion = MustBeTrue<BothWays<GenerateDocumentBody['doc_type'], DocType>>
// The non-vacuity controls for the line above. `MustBeTrue<BothWays<...>>` is also
// satisfied by a `BothWays` that degenerates to `true` or collapses to a one-way
// `extends`, either of which is a pin reporting success while comparing less than it
// claims. Both controls are derived from the field rather than listing members, so
// widening the contract legitimately does not make either one the failure.
//
// Each is an INVERTED assertion: the comparison must NOT hold, so `MustBeTrue` must
// reject it and `@ts-expect-error` consumes that error. This is self-checking in both
// directions — if the comparison starts holding the directive goes unused (TS2578),
// and if the directive is deleted the genuine TS2344 surfaces.
//
// WIDENED side — adding a member the route cannot accept must not compare equal.
// @ts-expect-error the field plus a member DocType lacks must NOT compare equal
export type DocTypeFieldPinWouldSeeDrift = MustBeTrue<BothWays<GenerateDocumentBody['doc_type'] | 'not-a-doc-type', DocType>>
// NARROWED side — refuses a `BothWays` collapsed to its ONE-WAY form, which the
// control above cannot see (see the ⚠️ note on `BothWays`). The field is narrower than
// itself-plus-a-member, so a one-way comparison calls this `true`, the directive goes
// unused and the line becomes a TS2578; two-way, it is `false` as required.
//
// Left side is the field — this pin's OWN operand — so this is a control on THIS pin
// and not merely on the shared `BothWays`; right side is derived from it, so no member
// is named that could go stale when the contract is widened.
// @ts-expect-error the field is narrower than itself plus a member, so NOT equal
export type DocTypeFieldPinWouldSeeNarrowing = MustBeTrue<BothWays<GenerateDocumentBody['doc_type'], DocType | 'not-a-doc-type'>>

export interface ProjectDocument {
  document_id: string
  // ⚠️ A SUPERSET of `DocType`, RESTATED as literals rather than referencing it — which
  // makes it a FIFTH edit a widening of `DocType` needs, stated here because no gate asks
  // for it. The generator persists this field straight from `doc_type`
  // (`'document_type': doc_type` at both save paths in
  // `lambda/jobs/document_generator/handler.py`), so a widened `DocType` produces rows
  // this union does not admit. Latent rather than absent: `tsc` is clean today only
  // because nothing assigns a `DocType` into this field, and a one-line probe making the
  // two meet is a TS2322 (measured).
  //
  // `DocType | 'research' | ...` would REMOVE the edit, and was tried. It is not
  // available: `lambda/api/test/test_kiro_exportable_types_lockstep.py` parses THIS union
  // as string literals to derive the full document-type set, and a referenced type makes
  // it read zero members — loudly, but it fails. Teaching that parser to resolve
  // `DocType` is a different contract's business (Kiro export inclusion, not this route's
  // allowlist) and belongs beside it, so the ceiling is named here instead — the same
  // call as the generator and picker ceilings in `lambda/api/test/test_doc_type_lockstep.py`.
  //
  // Superset deliberately: `research` and `custom` come from other routes,
  // `product_report` and `prototype` from their own. So this is NOT a second copy of the
  // route's contract and must not be pinned against `GENERATED_DOC_TYPES` — the same
  // reason `suggestDocumentBrief` is left unbound.
  document_type: 'prd' | 'prfaq' | 'research' | 'custom' | 'product_report' | 'prototype'
  title: string
  /** User-supplied series title before the system-managed `(vN)` suffix. */
  base_title?: string
  /** Stable, monotonic version within this project/type/base-title series. */
  version?: number
  // New (S3-only) HTML prototypes have NO `content` — the HTML lives at
  // `prototype_url` on CloudFront. Legacy prototypes (JSON specs, or
  // pre-migration HTML) and all non-prototype document types still use
  // `content` as before.
  content: string
  feature_idea?: string
  question?: string
  // For prototypes: 'html' → this is a self-contained HTML document, served
  // via `prototype_url` (new) or rendered from `content` via a sandboxed
  // iframe srcDoc (legacy fallback). Absent → legacy JSON spec rendered via
  // PrototypeRenderer.
  prototype_format?: 'html' | string
  // CloudFront URL for the generated prototype HTML (new prototypes only —
  // served from the /prototypes/* cache behavior with its own permissive CSP).
  // Absent on legacy prototypes; callers fall back to `content`/srcDoc.
  prototype_url?: string
  /**
   * What this document was built from — the one shape every document type uses
   * (see api/derivation.ts). Absent on every document created before the field
   * existed, and written as a sparse record when a document has no inputs, so
   * read it through `resolveDerivation` rather than directly: that also
   * reconstructs the answer from the legacy fields below.
   */
  derivation?: DocumentDerivation | null
  // ── Pre-`derivation` lineage, still written, now declared ──
  // These were on the wire long before this interface acknowledged them, and
  // `resolveDerivation` reads them for documents that predate `derivation`.
  // Both prototype ids are written as a REAL stored null (not an omitted key)
  // when a prototype was built from only one of the two, hence `| null`.
  /** The PRD a prototype was built from. */
  source_prd_id?: string | null
  /** The PR/FAQ a prototype was built from. */
  source_prfaq_id?: string | null
  /** The document ids a merge output was asked to merge (requested, not used). */
  source_documents?: string[]
  /** The instructions a merge output was produced with. */
  merge_instructions?: string
  /** Feedback items analyzed, on a research report. */
  feedback_count?: number
  /**
   * The prototype this one revises, and the feedback that drove the revision.
   * "This replaces that" is a DIFFERENT relation from "this was built from
   * that", so these are deliberately not part of `derivation`.
   */
  revised_from_id?: string | null
  revision_feedback?: string
  created_at: string
  updated_at?: string
}

export type ProductLifecycleState = '' | 'idea' | 'mvp' | 'beta' | 'ga' | 'mature'

export interface ProductContext {
  product_name: string
  one_liner: string
  target_users: string
  problem_solved: string
  current_state: ProductLifecycleState
  // The following are free-text comments — multi-line strings, not arrays.
  key_features: string
  differentiators: string
  known_limitations: string
  non_goals: string
  success_metrics: string
  free_form_notes: string
  updated_at?: string
}

export type ProductDocStatus = 'pending' | 'extracting' | 'ready' | 'failed'

export interface ProductDoc {
  doc_id: string
  filename: string
  content_type: string
  size_bytes: number
  status: ProductDocStatus
  error: string | null
  extracted_chars: number
  created_at: string
}

export interface ProductInterviewTurnResponse {
  assistant_message: string
  applied_patch: Partial<ProductContext>
  context: ProductContext
}

export interface ProductReportResponse {
  success: boolean
  document: ProjectDocument
}

export interface Project {
  project_id: string
  name: string
  description: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  persona_count: number
  document_count: number
  filters?: Record<string, unknown>
  kiro_export_prompt?: string
  /**
   * The backend's static default instructions, sent on every GET /projects/{id}
   * response so both the editor and "Copy to Kiro" can fall back to it without
   * duplicating the text in the frontend bundle.
   * Present on getProject responses; absent on list responses.
   */
  kiro_default_export_prompt?: string
}

export interface ProjectDetail {
  project: Project
  personas: ProjectPersona[]
  documents: ProjectDocument[]
}

/**
 * One reviewer's complete ballot on ONE ROW, as read back.
 *
 * `row_id`, not `document_id`: a prioritization row is a project's set of
 * documents and the ballot is about the row. A field named for a document would
 * name something the row merely contains — and every lookup on the page addresses
 * the row.
 */
export interface PrioritizationScore {
  row_id: string
  impact: number
  time_to_market: number
  confidence: number
  strategic_fit: number
  notes: string
}

/**
 * What a prioritization row IS: a project, and the concrete documents it holds.
 *
 * Returned as `rows` beside `scores` and `aggregates` on
 * `GET /projects/prioritization`, keyed by the same row id, so the page learns
 * every row's composition without a second round trip per row.
 *
 * `document_ids` are CONCRETE and stay put. "Latest of each type" is how a row is
 * first composed and not a pointer it keeps following, so generating a new PRD
 * changes no existing row — which is what keeps a ballot describing the documents
 * it was cast about. `prototype_id` is context a reviewer looks at rather than a
 * document the row is scored on, which is why it is its own field; it is `''` when
 * the project has no prototype.
 *
 * `is_frozen` says a ballot has landed, so the composition can no longer change. A
 * fact the page DISPLAYS, never one it enforces: the freeze is a condition on the
 * write itself, so a composition change racing the first ballot loses to it in the
 * database and answers 409 whatever this field said a moment earlier. The timestamp
 * behind it, and the write count the delete fences on, are deliberately NOT published
 * — a client computing the freeze itself would eventually disagree with the condition
 * that enforces it.
 */
export interface PrioritizationRow {
  row_id: string
  project_id: string
  document_ids: string[]
  prototype_id: string
  is_default: boolean
  created_at: string
  is_frozen: boolean
}

/**
 * One reviewer's change to their own ballot — only the fields they actually set.
 *
 * The body shape `PATCH /projects/prioritization` is built for: the verb means
 * "change what I sent", and `_ballot_update_kwargs` assigns only the axes an entry
 * CARRIES, treating an absent or null one as "leave it alone". So an omitted axis is
 * not a gap to be filled in before sending; it is the request saying nothing about
 * that axis.
 *
 * Distinct from `PrioritizationScore`, which is a COMPLETE ballot as read back, and
 * the distinction is load-bearing rather than cosmetic. Sending a full score for a
 * partial edit meant a reviewer who moved one slider on a fresh row also wrote the
 * other three axes — from `DEFAULT_SCORE`, so two of them as a `0` the slider
 * (`min={1}`) cannot express and none of them chosen by that reviewer. The backend
 * counts an explicit `0` as a real vote (`_carries_axis` is deliberately distinct
 * from `_axis_value(...) == 0`) and averages each axis over the reviewers who scored
 * it, so those fabricated zeros dragged the TEAM's means down for everybody — and
 * the team's means are what the prioritization list now displays, bands, counts and
 * sorts by.
 *
 * `PrioritizationScore` remains structurally assignable to this, so sending a
 * complete ballot is still valid where one genuinely exists.
 */
export interface PrioritizationBallotEdit {
  row_id: string
  impact?: number
  time_to_market?: number
  confidence?: number
  strategic_fit?: number
  notes?: string
}

/**
 * What every reviewer together said about one ROW.
 *
 * A sibling of `scores` on `GET /projects/prioritization`. Where `scores` holds
 * the CALLER'S OWN ballot, this holds the cross-reviewer view: each axis is the
 * mean over the reviewers who scored that axis, and `score_spread` is the range
 * of the composite priority score — weighted exactly as `calculatePriorityScore`,
 * so it is expressed in the notches the page already sorts by. Zero spread means
 * agreement, or fewer than two comparable ballots.
 *
 * Three things a consumer has to know, all decided on the backend
 * (`_aggregate_scores` in `projects_handler.py`) and repeated here because this
 * is where a frontend author reads:
 *
 *  - Rows NOBODY scored are absent, so presence means "somebody scored
 *    this" — do not treat a missing key as a zero row.
 *  - An entry can OUTLIVE its row. Ballots live beside the row record and nothing
 *    removes them in this phase, so intersect these keys with the `rows` map
 *    rather than using this one as a row index.
 *  - `score_spread` compares only reviewers who scored EVERY axis, and is 0 below
 *    two of them, so it can be 0 while `reviewer_count` is greater than 1. An
 *    absent axis counts as zero in the composite, so comparing a partially-scored
 *    ballot would report how completely people scored rather than how much they
 *    disagreed. The means describe everyone who scored; the spread describes only
 *    those comparable like for like.
 *
 * `reviewer_count` counts reviewers who scored at least one axis; a ballot
 * carrying only a note is a legal save but not a vote and is not counted.
 */
export interface PrioritizationAggregate {
  impact: number
  time_to_market: number
  confidence: number
  strategic_fit: number
  reviewer_count: number
  score_spread: number
}

export interface S3ImportSource {
  name: string
  display_name: string
}

export interface S3ImportFile {
  key: string
  filename: string
  source: string
  size: number
  last_modified: string
  status: 'pending' | 'processed'
}

/**
 * Shared form configuration fields used by both FeedbackFormConfig and FeedbackForm.
 *
 * Only fields safe to publish belong here: FeedbackFormConfig extends this and
 * is the body of the UNAUTHENTICATED widget config route. Internal identifiers
 * — the project_id/document_id a form validates, for instance — go on
 * FeedbackForm instead. `feedbackFormTypes.test.ts` asserts that boundary over
 * this declaration.
 */
interface FeedbackFormFields {
  title: string
  description: string
  question: string
  placeholder: string
  rating_enabled: boolean
  rating_type: 'stars' | 'numeric' | 'emoji'
  rating_max: number
  submit_button_text: string
  success_message: string
  theme: {
    primary_color: string
    background_color: string
    text_color: string
    border_radius: string
  }
  collect_email: boolean
  collect_name: boolean
  custom_fields: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean
  }>
}

export interface FeedbackFormConfig extends FeedbackFormFields {
  enabled: boolean
  brand_name: string
}

export interface FeedbackForm extends FeedbackFormFields {
  form_id: string
  name: string
  enabled: boolean
  category: string
  subcategory: string
  // Optional link to the artefact this form validates. Declared here rather
  // than on FeedbackFormFields ON PURPOSE: FeedbackFormFields is shared with
  // FeedbackFormConfig, which is the response of the UNAUTHENTICATED widget
  // config route served to customers' own websites. These are internal
  // identifiers and must never appear there.
  //
  // Optional in the type as well as at rest: absent or '' both mean
  // "validates nothing" — the standalone website-survey case, and the shape
  // every form template and every record persisted before this field existed
  // still has. project_id is the durable half of the link: regenerating a
  // document mints a new document_id, so readers match on project first and
  // treat document_id as a refinement.
  project_id?: string
  document_id?: string
  created_at: string
  updated_at: string
}

export interface CognitoUser {
  username: string
  email: string
  name: string
  given_name?: string
  family_name?: string
  status: string
  enabled: boolean
  groups: string[]
  created_at: string | null
  last_modified: string | null
}

// Logs Types
export interface ValidationLogEntry {
  source_platform: string
  message_id: string
  timestamp: string
  log_type: 'validation_failure'
  errors: string[]
  raw_preview?: string
}

export interface ProcessingLogEntry {
  source_platform: string
  message_id: string
  timestamp: string
  log_type: 'processing_error'
  error_type: string
  error_message: string
}

export interface ScraperLogEntry {
  run_id: string
  status: string
  started_at: string
  completed_at?: string
  pages_scraped: number
  items_found: number
  errors: string[]
}

export interface LogsSummary {
  validation_failures: Record<string, number>
  processing_errors: Record<string, number>
  total_validation_failures: number
  total_processing_errors: number
}

/**
 * Metadata for an API token used by external integrations to ingest feedback.
 * The raw token value is only returned once at creation time
 * (see CreateApiTokenResponse).
 */
export interface ApiToken {
  token_id: string
  name: string
  /** Per-domain grants (`feedback:read`, …). Replaces the old single `scope`,
   *  whose `read-write` value was mintable but required by no tool. */
  scopes: McpScope[]
  /** The projects this credential is about. Bounds reads when read_reach is
   *  'project-set'; will bound writes when write tools land. */
  projects: string[]
  /** How far the credential may read. 'workspace' is the default and is NOT
   *  the harmless option — see READ_REACHES. */
  read_reach: ReadReach
  created_at: string
  last_used_at?: string
  /** ISO-8601 deadline after which the token stops authenticating; absent for
   *  non-expiring tokens. */
  expires_at?: string
}

/** Response when creating an API token; `token` is the only time the raw value is returned. */
export interface CreateApiTokenResponse {
  token: string
  token_id: string
  name: string
  scopes: McpScope[]
  projects: string[]
  read_reach: ReadReach
  /** Echo of the minted deadline; absent when the token does not expire. */
  expires_at?: string
}


/**
 * A public-web search result returned by the AI chat web_search tool
 * (Amazon Bedrock AgentCore Web Search). Acceptable use requires surfacing
 * these citations alongside any answer that draws on them.
 */
export interface WebSource {
  title: string
  url: string
  text: string
  published_date: string
}
