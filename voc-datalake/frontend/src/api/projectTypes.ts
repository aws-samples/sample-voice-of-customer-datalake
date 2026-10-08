// Project, product-context and prioritization wire types, split out of
// api/types.ts to keep that file under the max-lines gate.
//
// Still in types.ts, because something reads them from that path:
//  * `ProductDocStatus` — a Python lockstep test
//    (product_doc_extractor/test/test_status_lockstep.py) parses that file;
//    `KnownProjectDocumentType` stays beside it;
//  * `ProjectDocument`, `PrioritizationScore`, `PrioritizationBallotEdit` —
//    imported from there by pages/Prioritization/prioritizationUtils.ts.
import type { ProductDocStatus, ProjectDocument } from './types'

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
     * Document jobs (PRD / PR-FAQ) report how much of the corpus the model saw
     * at the top level of `result` (#231); persona jobs report it under
     * `metadata` below. Optional: older jobs and other job types omit them.
     */
    feedback_items_used?: number
    context_truncated?: boolean
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
  /**
   * The backend's Kiro instructions, sent on every GET /projects/{id} response so
   * "Copy to Kiro" does not duplicate the text in the frontend bundle. Present on
   * getProject responses; absent on list responses. (The per-project
   * `kiro_export_prompt` override was retired in 3.00.00 and is not sent.)
   */
  kiro_default_export_prompt?: string
  // ── Sharing (computed by the API on every list/get/create response) ──
  // Optional so legacy fixtures and pre-permissions payloads stay valid; the
  // normalizers in projectDetailSchema.ts fill safe defaults at the boundary.
  visibility?: ProjectVisibility
  owner?: ProjectOwner | null
  access?: ProjectAccess
  member_count?: number
  /** Present on GET /projects/{id} only. */
  members?: ProjectMember[]
}

/** POST /projects request body; shared by projectsApi and the client.ts wrapper. */
export interface CreateProjectBody {
  name: string
  description?: string
  filters?: Record<string, unknown>
  /** Omitted = the server default, 'private'. */
  visibility?: ProjectVisibility
}

/** 'public' = every signed-in user can view and edit (legacy); 'private' = owner, members, admins. */
export type ProjectVisibility = 'public' | 'private'
/** A caller's effective role on one project (only read through `ProjectAccess.role`). */
type ProjectRole = 'owner' | 'admin' | 'editor' | 'viewer'
/** The roles an invited member can hold. */
export type ProjectMemberRole = 'editor' | 'viewer'

export interface ProjectOwner {
  sub: string
  username: string
  email: string
}

export interface ProjectAccess {
  role: ProjectRole | null
  can_view: boolean
  can_edit: boolean
  can_manage: boolean
}

export interface ProjectMember {
  sub: string
  role: ProjectMemberRole
  username: string
  email: string
  added_by?: string
  added_at?: string
}

/** GET /projects/{id}/members */
export interface ProjectMembersResponse {
  visibility: ProjectVisibility
  owner: ProjectOwner | null
  members: ProjectMember[]
  access: ProjectAccess
}

/** One row of GET /projects/{id}/members/candidates */
export interface ProjectMemberCandidate {
  sub: string
  username: string
  email: string
  name?: string
}

export interface ProjectDetail {
  project: Project
  personas: ProjectPersona[]
  documents: ProjectDocument[]
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
