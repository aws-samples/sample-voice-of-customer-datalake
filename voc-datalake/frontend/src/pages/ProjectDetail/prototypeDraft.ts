/**
 * Which prototype draft the page shows (docs/prototype-builder.md, part 2), as pure rules.
 *
 * A draft is a finished `draft_prototype` job (its id is the draft id); its detail comes from the draft
 * GET. The page reads the newest few and shows the newest one made on the open prototype's series:
 *
 * - `fresh`: its base is the series' newest version, so Apply writes the next one;
 * - `stale`: the series has moved past its base (someone saved, restored or revised): Apply would be a
 *   409, so the banner says so up front and offers only Discard;
 * - applied: a version of the series records this draft (a revise of its base with its instruction),
 *   so there is nothing left to do and no banner (the draft's job stays until it expires or is dismissed,
 *   which keeps a replayed Apply idempotent).
 *
 * @module pages/ProjectDetail/prototypeDraft
 */
import type { ProjectJob } from '../../api/projectTypes'
import type { ProjectDocument } from '../../api/types'
import type { PrototypeDraft } from '../../api/prototypeDraftSchema'

/**
 * How many of the newest finished drafts the page reads, one GET each through the open prototype's route
 * (a 404 is a draft of another series, or one gone). The window is the whole project's, so it must be wide
 * enough that other prototypes' drafts do not hide this one's: a draft lives 7 days (its job's lifetime) and
 * the jobs list holds only the project's 50 newest jobs, so 10 covers a busy week of drafting several
 * prototypes at a bounded cost.
 */
const MAX_DRAFTS_READ = 10

/** What `revision_feedback` keeps of the instruction (the server caps it at 2,000 characters). */
const FEEDBACK_CAP = 2000

/** The draft ids (= their job ids) of the newest finished draft jobs, newest first, at most MAX_DRAFTS_READ. */
export function draftCandidates(jobs: readonly ProjectJob[]): string[] {
  return jobs
    .filter((job) => job.job_type === 'draft_prototype' && job.status === 'completed')
    .map((job) => ({ id: job.job_id, at: job.completed_at ?? job.created_at }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX_DRAFTS_READ)
    .map(({ id }) => id)
}

type DraftState = 'fresh' | 'stale'

export interface ShownDraft {
  readonly draft: PrototypeDraft
  readonly state: DraftState
}

/** Whether a version of the series is this draft applied: a revise of its base with its instruction. */
function wasApplied(draft: PrototypeDraft, series: readonly ProjectDocument[]): boolean {
  const feedback = draft.instruction.slice(0, FEEDBACK_CAP)
  return series.some((d) => (d.version ?? 0) > draft.base_version
    && d.revised_from_id === draft.base_document_id && d.revision_feedback === feedback)
}

/**
 * The draft to show beside `series` (newest version first), from `drafts` in the order read (newest
 * first; null = gone): the first whose base is a version of the series and that is not applied yet.
 */
export function shownDraft(
  drafts: readonly (PrototypeDraft | null | undefined)[], series: readonly ProjectDocument[],
): ShownDraft | null {
  const ids = new Set(series.map((d) => d.document_id))
  const headVersion = series[0]?.version ?? 0
  for (const draft of drafts) {
    if (draft !== null && draft !== undefined && ids.has(draft.base_document_id) && !wasApplied(draft, series)) {
      return { draft, state: draft.base_version >= headVersion ? 'fresh' : 'stale' }
    }
  }
  return null
}
