/**
 * @fileoverview What an erasure job's row asks of an admin (7.97.00, projects 3g-ui; docs/multi-workspace.md): its
 * review list by kind, the follow-ups its flags call for and the rerun text each gets, what a later job of the list
 * resolved, the outcome its badge reads (`jobReport`, once per row), and which jobs belong to a panel's scope. Pure:
 * the panels render it (erasureParts.tsx). When in doubt it says something is still needed.
 *
 * The rules (TENETS.md D5, docs/source-policies.md), for a finished erasure by email without a source:
 * - the operator's, before any rerun: a malformed participant row (`participant_guards_malformed`: a rerun does not
 *   mend it), an index row a rerun of the same erasure kept again (`participant_index_rows_kept` on both), a skipped
 *   malformed project id (`project_ids_malformed`, whatever the field), and owed lineage whose code (or, without one,
 *   its registries check) says the registries are not complete or its owe could not be recorded;
 * - submit again when `participants_complete` is not true (every one that finished before 7.72.00 too; a kept index
 *   row needs only this), and, the deployment's only, when `deployment_projects_walked` is not true (7.48.00) or the
 *   agents' memory was not walked (7.84.00); only the participants rerun of the deployment's own erasure carries the
 *   condition that the deployment has its own request for the address;
 * - an agents' memory account holding the address unverified (`agent_memory_accounts_not_erased`) is not a rerun: the
 *   admin erases by that account's current, verified address;
 * - files left to review (either list's keys or `more`, or a product document not checked), then owed lineage a later
 *   run makes.
 * What a later job resolves (`jobReport`'s `resolved`), only on positive proof from a completed job of the same scope started
 * after this one ended (a job started while it ran may have read the owed row before it was written; the deployment's
 * erasures are not serialised):
 * - owed lineage, when the row has a code other than `owe_failed` (an unrecorded owe is on no owed row) and the later
 *   job replayed what was owed or read complete registries owing nothing; the view gives older rows their code;
 * - each rerun on its own, by a later run of the same erasure (value hash, field, source, workspace): the participants
 *   and their malformed or kept rows by `participants_complete` true with none malformed or kept, the deployment's
 *   projects by `deployment_projects_walked` true, the agents' memory (either step) by `agent_memory_complete` true.
 *   A missing field is never proof. Malformed project ids are never resolved: their counter is on the row only once
 *   above 0, so a later run's row without it proves nothing (docs/multi-workspace.md, 3g-ui).
 *
 * @module components/SourcesManager/erasureOutcome
 */
import type { ErasureJob } from '../../api/sourceProfilesApi'

/** A kept key's kind: an upload kept, an import's originals folder, a document (product document, library item), or
 *  a project's product description or proposal (7.109.01: rows of the project, edited on its Product tab). */
interface ReviewGroups {
  uploads: string[]
  folders: string[]
  documents: string[]
  product: string[]
}

/** A project's product documents (`projects/<id>/product_docs/`, `ws/<ws>/…` in a workspace) or a library item
 *  (`library/<item>/…`), the keys lambda/jobs/retention/project_people.py lists. */
const DOCUMENT_KEY = /^(ws\/[^/]+\/)?(projects\/[^/]+\/product_docs|library)\//
/** A project's product description (`projects/<id>/product-context`) or one of its product proposals
 *  (`projects/<id>/product-proposals/<proposal_id>`), `ws/<ws>/…` in a workspace: the routes
 *  lambda/jobs/retention/project_people.py lists them by (7.104.00). No file: they are edited on the Product tab. */
const PRODUCT_KEY = /^(ws\/[^/]+\/)?projects\/[^/]+\/(product-context|product-proposals\/[^/]+)$/

export function reviewGroups(keys: readonly string[]): ReviewGroups {
  const groups: ReviewGroups = { uploads: [], folders: [], documents: [], product: [] }
  for (const key of keys) {
    if (DOCUMENT_KEY.test(key)) groups.documents.push(key)
    else if (PRODUCT_KEY.test(key)) groups.product.push(key)
    else if (key.endsWith('/')) groups.folders.push(key)
    else groups.uploads.push(key)
  }
  return groups
}

export type FollowUp =
  | { kind: 'malformedRows'; malformed: number }
  | { kind: 'indexRowsKeptAgain'; kept: number }
  | { kind: 'malformedProjectIds'; ids: number }
  | { kind: 'participants'; kept: number }
  | { kind: 'deploymentProjects' }
  | { kind: 'agentMemory' }
  | { kind: 'agentMemoryAccounts'; accounts: number }
  | { kind: 'lineageOwed'; code: ErasureJob['lineage_owed_reason']; reason: string }
  | { kind: 'filesToReview' }

type Kind = FollowUp['kind']
/** The steps a later run of the same erasure can resolve, each by its own proof (`PROOF`); `Resolved` adds owed
 *  lineage, which a later run of any erasure of the scope can make. */
type ResolvableKind = 'malformedRows' | 'indexRowsKeptAgain' | 'participants' | 'deploymentProjects' | 'agentMemory'
  | 'agentMemoryAccounts'
type Resolved = 'lineage' | ResolvableKind

const RERUN_KINDS: ReadonlySet<Kind> = new Set<Kind>(['participants', 'deploymentProjects', 'agentMemory'])
const OPERATOR_KINDS: ReadonlySet<Kind> = new Set<Kind>(['malformedRows', 'indexRowsKeptAgain', 'malformedProjectIds'])

/** What a later run of the same erasure must read to prove a step done (a missing field is no proof). */
const PROOF: Record<ResolvableKind, (later: ErasureJob) => boolean> = {
  malformedRows: participantsDone,
  indexRowsKeptAgain: participantsDone,
  participants: participantsDone,
  deploymentProjects: (later) => later.deployment_projects_walked === true && later.pins_walked === true,
  agentMemory: (later) => later.agent_memory_complete === true,
  agentMemoryAccounts: (later) => later.agent_memory_complete === true,
}

function participantsDone(later: ErasureJob): boolean {
  return later.participants_complete === true && later.participant_guards_malformed === 0
    && later.participant_index_rows_kept === 0
}

function isResolvable(kind: Kind): kind is ResolvableKind {
  return Object.hasOwn(PROOF, kind)
}

function emailWithoutSource(job: ErasureJob): boolean {
  return job.field === 'email' && job.source === undefined
}

function sameScope(job: ErasureJob, other: ErasureJob): boolean {
  return (job.workspace_id ?? null) === (other.workspace_id ?? null)
}

/** A run of the same erasure: the same value hash, field, source and workspace. */
function sameErasure(job: ErasureJob, other: ErasureJob): boolean {
  return other.value_hash === job.value_hash && other.field === job.field && other.source === job.source
    && sameScope(job, other)
}

/** Whether `later` is a completed job of the list, of `job`'s scope, started after `job` ended. */
function isLaterCompleted(job: ErasureJob, later: ErasureJob): boolean {
  return later.status === 'completed' && job.finished_at !== undefined && later.created_at > job.finished_at
    && sameScope(job, later)
}

/** Whether a completed run of the same erasure that ended before this one started also kept an index row: this one
 *  kept it again (an overlapping run proves nothing of this one). */
function keptAgain(job: ErasureJob, jobs: readonly ErasureJob[]): boolean {
  return job.participant_index_rows_kept > 0 && jobs.some((earlier) => isLaterCompleted(earlier, job)
    && earlier.status === 'completed' && sameErasure(job, earlier) && earlier.participant_index_rows_kept > 0)
}

function participantSteps(job: ErasureJob, jobs: readonly ErasureJob[]): FollowUp[] {
  if (job.participant_guards_malformed > 0) return [{ kind: 'malformedRows', malformed: job.participant_guards_malformed }]
  if (keptAgain(job, jobs)) return [{ kind: 'indexRowsKeptAgain', kept: job.participant_index_rows_kept }]
  return job.participants_complete === true ? [] : [{ kind: 'participants', kept: job.participant_index_rows_kept }]
}

function agentMemorySteps(job: ErasureJob): FollowUp[] {
  if (job.agent_memory_complete !== false) return []
  const accounts = job.agent_memory_accounts_not_erased
  if (job.agent_memory_walked === true && accounts > 0) return [{ kind: 'agentMemoryAccounts', accounts }]
  return [{ kind: 'agentMemory' }]
}

function emailSteps(job: ErasureJob, jobs: readonly ErasureJob[]): FollowUp[] {
  if (!emailWithoutSource(job)) return []
  // 7.98.00: a walk that did not reach every prototype pin (`pins_walked`) left the deployment's projects unfinished.
  const projects: FollowUp[] = job.workspace_id === undefined
    && (job.deployment_projects_walked !== true || job.pins_walked !== true)
    ? [{ kind: 'deploymentProjects' }] : []
  return [...participantSteps(job, jobs), ...projects, ...agentMemorySteps(job)]
}

function hasFilesToReview(job: ErasureJob): boolean {
  const kept = [job.files_needing_review, job.files_not_checked]
  return kept.some((list) => list !== undefined && (list.keys.length > 0 || list.more)) || job.product_docs_not_checked > 0
}

/** Whether a later run made the owed marks: it replayed what was owed, or read complete registries owing nothing.
 *  Every run that checks the registries also runs its lineage phase when it can (held by
 *  lambda/jobs/retention/test/test_registries_phase_lists.py), so complete registries owing nothing means a replay. */
function madeLineage(later: ErasureJob): boolean {
  return later.lineage_owed_replayed === true || (later.review_registries === 'complete' && later.lineage_owed !== true)
}

/** Whether owed lineage waits on the operator: by the row's code when it has one (only a run that failed before its
 *  marks leaves them to a later run), else by its registries check (anything but complete). A completed job that owes
 *  lineage (never `failed_before_marks`: the worker writes that code on a failed run) therefore reads the operator's;
 *  the code branch is kept as a defence. */
function owedToOperator(job: ErasureJob): boolean {
  if (job.lineage_owed_reason !== undefined) return job.lineage_owed_reason !== 'failed_before_marks'
  return job.review_registries !== 'complete'
}

/** What later completed jobs of the list resolved of this one's follow-ups (`email`: its open email steps), each
 *  on its own proof (`jobReport`'s `resolved`). */
function resolve(job: ErasureJob, jobs: readonly ErasureJob[], email: readonly FollowUp[]): Resolved[] {
  if (job.status === 'queued' || job.status === 'running') return []
  const later = jobs.filter((other) => isLaterCompleted(job, other))
  const code = job.lineage_owed_reason
  const out: Resolved[] = []
  // Owed lineage, completed or failed (a run that failed before its marks is the common owing one).
  if (job.lineage_owed === true && code !== undefined && code !== 'owe_failed' && later.some(madeLineage)) out.push('lineage')
  // The reruns, of a completed job only (a failed one's error says what to do).
  if (job.status !== 'completed') return out
  const again = later.filter((other) => sameErasure(job, other))
  for (const { kind } of email) {
    if (isResolvable(kind) && again.some(PROOF[kind])) out.push(kind)
  }
  return out
}

/** A job's report: what it still needs (`steps`, in the order the panel lists them), what a later job of `jobs`
 *  resolved, whether every rerun it needed is done (`rerunDone`: none left, the verified-address step never counting),
 *  and its badge's outcome. */
export interface JobReport {
  steps: FollowUp[]
  resolved: Resolved[]
  rerunDone: boolean
  outcome: JobOutcome
}

/** What the job's badge reads: its status, or, for a completed job with a follow-up, the first that applies of the
 *  operator's (rows, ids, owed lineage waiting on the operator), a rerun, an erasure by a verified address, files to
 *  review, and owed lineage a later run makes. */
export type JobOutcome = ErasureJob['status'] | 'operator' | 'rerun' | 'verifiedAddress' | 'filesToReview' | 'lineageOwed'

function erasureOutcomeOf(job: ErasureJob, steps: readonly FollowUp[]): JobOutcome {
  if (job.status !== 'completed') return job.status
  const kinds = new Set(steps.map((step) => step.kind))
  const has = (set: ReadonlySet<Kind>) => [...kinds].some((kind) => set.has(kind))
  if (has(OPERATOR_KINDS) || (kinds.has('lineageOwed') && owedToOperator(job))) return 'operator'
  if (has(RERUN_KINDS)) return 'rerun'
  if (kinds.has('agentMemoryAccounts')) return 'verifiedAddress'
  if (kinds.has('filesToReview')) return 'filesToReview'
  return kinds.has('lineageOwed') ? 'lineageOwed' : 'completed'
}

/** The steps a rerun of the same erasure finishes (the verified-address step is not one: it needs Users first). */
const RERUN_DONE_KINDS: ReadonlySet<Kind> = new Set<Kind>([...RERUN_KINDS, 'malformedRows', 'indexRowsKeptAgain'])

export function jobReport(job: ErasureJob, jobs: readonly ErasureJob[] = []): JobReport {
  if (job.status === 'queued' || job.status === 'running') {
    return { steps: [], resolved: [], rerunDone: false, outcome: job.status }
  }
  const email = job.status === 'completed' ? emailSteps(job, jobs) : []
  const resolved = resolve(job, jobs, email)
  const owed: FollowUp[] = job.lineage_owed === true && !resolved.includes('lineage')
    ? [{ kind: 'lineageOwed', code: job.lineage_owed_reason, reason: job.incomplete_reason ?? '' }]
    : []
  const done = job.status === 'completed' ? completedSteps(job, email, resolved) : []
  // The operator's owed lineage is listed first; owed lineage a later run makes, last.
  const steps = owed.length > 0 && owedToOperator(job) ? [...owed, ...done] : [...done, ...owed]
  const rerunDone = resolved.some((kind) => kind !== 'lineage' && RERUN_DONE_KINDS.has(kind))
    && !steps.some((step) => RERUN_DONE_KINDS.has(step.kind))
  return { steps, resolved, rerunDone, outcome: erasureOutcomeOf(job, steps) }
}

function completedSteps(job: ErasureJob, email: readonly FollowUp[], resolved: readonly Resolved[]): FollowUp[] {
  const ids: FollowUp[] = job.project_ids_malformed > 0 ? [{ kind: 'malformedProjectIds', ids: job.project_ids_malformed }] : []
  const open = email.filter((step) => !resolved.some((kind) => kind === step.kind))
  const files: FollowUp[] = hasFilesToReview(job) ? [{ kind: 'filesToReview' }] : []
  return [...ids, ...open, ...files]
}

/** Which rerun text a rerun step gets: a workspace's job is submitted again from that workspace; the deployment's
 *  participants rerun only where the deployment has its own request for the address (TENETS.md D5); the
 *  deployment's other reruns, plainly. */
export function rerunAdvice(step: Readonly<{ kind: Kind }>, job: ErasureJob): 'workspace' | 'ownRequest' | 'plain' {
  if (job.workspace_id !== undefined) return 'workspace'
  return step.kind === 'participants' ? 'ownRequest' : 'plain'
}

/** The standing line on every deployment erasure by email that walked the agents' memory: an account whose email
 *  changed, or that holds the address unverified and is not its username, is not reached by the address. */
export function agentMemoryReachNote(job: ErasureJob): boolean {
  return job.workspace_id === undefined && emailWithoutSource(job) && job.agent_memory_walked === true
}

/** Whether a job belongs to a panel's scope: inside a workspace (`workspaceId`) that workspace's own jobs, outside one
 *  (null) the deployment's, which name no workspace. The server lists only these (lambda/shared/erasure_scope.py);
 *  the panel holds to it too. */
export function jobInScope(job: Pick<ErasureJob, 'workspace_id'>, workspaceId: string | null): boolean {
  return (job.workspace_id ?? null) === workspaceId
}
