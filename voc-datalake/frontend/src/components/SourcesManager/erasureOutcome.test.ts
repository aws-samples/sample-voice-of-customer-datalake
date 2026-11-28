/**
 * What an erasure job's row asks of an admin (7.97.00, projects 3g-ui): the review lists by kind, the rerun rules
 * (participants, the deployment's projects, the agents' memory) and the text each gets, the rows an operator looks at,
 * owed lineage, the files left to review, what a later job resolved, and which jobs belong to the panel's scope.
 */
import { describe, expect, it } from 'vitest'
import { agentMemoryReachNote, jobInScope, jobReport, rerunAdvice, reviewGroups } from './erasureOutcome'
import { normalizeErasureJob } from '../../api/sourceProfilesApi'
import type { ErasureJob } from '../../api/sourceProfilesApi'

const followUps = (job: ErasureJob, jobs: readonly ErasureJob[] = []) => jobReport(job, jobs).steps
const jobOutcome = (job: ErasureJob, jobs: readonly ErasureJob[] = []) => jobReport(job, jobs).outcome
const resolvedLater = (job: ErasureJob, jobs: readonly ErasureJob[] = []) => jobReport(job, jobs).resolved

const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
/** A deployment's erasure by email without a source that walked everything. */
const CLEAN = {
  job_id: 'er_1', status: 'completed', field: 'email', value_hash: 'abc', created_at: '2026-11-01T10:00:00Z',
  finished_at: '2026-11-01T10:05:00Z',
  deployment_projects_walked: true, pins_walked: true, participants_walked: true, participants_complete: true, review_registries: 'complete',
}

function jobWith(extra: Record<string, unknown>) {
  const job = normalizeErasureJob({ job: { ...CLEAN, ...extra } })
  if (job === null) throw new Error('fixture job did not normalize')
  return job
}

const kinds = (job: ReturnType<typeof jobWith>, jobs: ReturnType<typeof jobWith>[] = []) =>
  followUps(job, jobs).map((step) => step.kind)

describe('reviewGroups', () => {
  it('names each kind of key: an upload kept, an import originals folder, a document that holds the address', () => {
    expect(reviewGroups([
      'raw/csv_upload/2026/01/01/j.csv',
      `ws/${WS}/raw/s3_import/`,
      `ws/${WS}/projects/p_1/product_docs/brief.md`,
      'projects/p_2/product_docs/notes.txt',
      `ws/${WS}/library/li_1/original`,
    ])).toStrictEqual({
      uploads: ['raw/csv_upload/2026/01/01/j.csv'],
      folders: [`ws/${WS}/raw/s3_import/`],
      documents: [`ws/${WS}/projects/p_1/product_docs/brief.md`, 'projects/p_2/product_docs/notes.txt',
        `ws/${WS}/library/li_1/original`],
      product: [],
    })
  })

  // Review S1 (7.104.00 gate): the erasure lists a project's product description and proposals by their routes
  // (lambda/jobs/retention/project_people.py), which read as uploaded files kept.
  it.each([
    ['the deployment\'s product description', 'projects/proj_1/product-context'],
    ['a workspace\'s product description', `ws/${WS}/projects/proj_1/product-context`],
    ['the deployment\'s proposal', 'projects/proj_1/product-proposals/pp_20261126T120000000000Z_aaaaaaaaaaaa'],
    ['a workspace\'s proposal', `ws/${WS}/projects/proj_1/product-proposals/pp_20261126T120000000000Z_aaaaaaaaaaaa`],
  ])('reads %s as a product entry, never an upload', (_case, key) => {
    expect(reviewGroups([key])).toStrictEqual({ uploads: [], folders: [], documents: [], product: [key] })
  })

  it('reads a key that only starts like a product entry as an upload', () => {
    const keys = ['projects/proj_1/product-context/extra', 'projects/proj_1/product-proposals/', 'raw/projects/p/product-context']
    expect(reviewGroups(keys)).toStrictEqual({ uploads: [keys[0], keys[2]], folders: [keys[1]], documents: [], product: [] })
  })

  it('reads a product documents folder (an image the erasure could not read) as a document, not an import folder', () => {
    expect(reviewGroups([`ws/${WS}/projects/p_1/product_docs/img_1/`]).documents).toHaveLength(1)
  })

  it('reads an upload of a source named library as an upload, not a library item', () => {
    expect(reviewGroups(['raw/library/2026/01/01/a.csv']).uploads).toStrictEqual(['raw/library/2026/01/01/a.csv'])
  })
})

describe('followUps', () => {
  it('asks nothing of a clean erasure', () => {
    expect(followUps(jobWith({}))).toStrictEqual([])
    expect(jobOutcome(jobWith({}))).toBe('completed')
  })

  it('asks for a rerun when the participants are not complete, or the field is missing (before 7.72.00)', () => {
    expect(kinds(jobWith({ participants_complete: false }))).toStrictEqual(['participants'])
    expect(kinds(jobWith({ participants_complete: undefined, participants_walked: undefined }))).toStrictEqual(['participants'])
    expect(jobOutcome(jobWith({ participants_complete: false }))).toBe('rerun')
  })

  it("asks the deployment's erasure for a rerun when its own projects were not walked, never a workspace's", () => {
    expect(kinds(jobWith({ deployment_projects_walked: false }))).toStrictEqual(['deploymentProjects'])
    expect(kinds(jobWith({ deployment_projects_walked: undefined }))).toStrictEqual(['deploymentProjects'])
    expect(kinds(jobWith({ deployment_projects_walked: undefined, workspace_id: WS }))).toStrictEqual([])
  })

  it("asks for a rerun when the deployment's walk did not reach every prototype pin (7.98.00, pins_walked)", () => {
    expect(kinds(jobWith({ pins_walked: undefined }))).toStrictEqual(['deploymentProjects'])
    expect(kinds(jobWith({ pins_walked: false }))).toStrictEqual(['deploymentProjects'])
    expect(kinds(jobWith({ pins_walked: undefined, workspace_id: WS }))).toStrictEqual([])
    const old = jobWith({ pins_walked: undefined })
    const later = (extra: Record<string, unknown>) =>
      jobWith({ job_id: 'er_again', created_at: '2026-11-02T10:00:00Z', finished_at: '2026-11-02T10:05:00Z', ...extra })
    expect(kinds(old, [later({ pins_walked: undefined }), old])).toStrictEqual(['deploymentProjects'])
    expect(kinds(old, [later({}), old])).toStrictEqual([])
  })

  it("asks for a rerun when the agents' memory was not walked, and nothing when it was not due or is complete", () => {
    expect(kinds(jobWith({ agent_memory_walked: false, agent_memory_complete: false }))).toStrictEqual(['agentMemory'])
    expect(kinds(jobWith({ agent_memory_walked: true, agent_memory_complete: true }))).toStrictEqual([])
    expect(kinds(jobWith({}))).toStrictEqual([])
  })

  it("asks for an erasure by the account's verified address, not a rerun, when an account held this one unverified", () => {
    const job = jobWith({ agent_memory_walked: true, agent_memory_complete: false, agent_memory_accounts_not_erased: 2 })
    expect(followUps(job)).toStrictEqual([{ kind: 'agentMemoryAccounts', accounts: 2 }])
    expect(jobOutcome(job)).toBe('verifiedAddress')
  })

  it('applies the rerun rules to an erasure by email without a source only', () => {
    expect(kinds(jobWith({ field: 'author', participants_complete: undefined, deployment_projects_walked: undefined })))
      .toStrictEqual([])
    expect(kinds(jobWith({ source: 'tickets', participants_complete: undefined }))).toStrictEqual([])
  })

  it('sends a malformed participant row to the operator before any rerun', () => {
    const job = jobWith({ participant_guards_malformed: 2, participant_index_rows_kept: 1, participants_complete: false })
    expect(followUps(job)).toStrictEqual([{ kind: 'malformedRows', malformed: 2 }])
    expect(jobOutcome(job)).toBe('operator')
    // A row written by 7.72.00 says complete beside a malformed count: still the operator's.
    expect(jobOutcome(jobWith({ participant_guards_malformed: 1, deployment_projects_walked: false }))).toBe('operator')
  })

  it('sends skipped malformed project ids to the operator, whatever the field', () => {
    const job = jobWith({ field: 'author', project_ids_malformed: 3 })
    expect(followUps(job)).toStrictEqual([{ kind: 'malformedProjectIds', ids: 3 }])
    expect(jobOutcome(job)).toBe('operator')
  })

  it('asks only for a rerun when an index row was kept, with the kept count', () => {
    const job = jobWith({ participant_index_rows_kept: 1, participants_complete: false })
    expect(followUps(job)).toStrictEqual([{ kind: 'participants', kept: 1 }])
    expect(jobOutcome(job)).toBe('rerun')
  })

  it('sends an index row kept again by a rerun of the same erasure to the operator', () => {
    const first = jobWith({ job_id: 'er_a', participant_index_rows_kept: 1, participants_complete: false })
    const again = jobWith({ job_id: 'er_b', participant_index_rows_kept: 1, participants_complete: false,
      created_at: '2026-11-02T10:00:00Z', finished_at: '2026-11-02T10:05:00Z' })
    expect(followUps(again, [again, first])).toStrictEqual([{ kind: 'indexRowsKeptAgain', kept: 1 }])
    expect(jobOutcome(again, [again, first])).toBe('operator')
  })

  it('counts as kept again only a completed earlier run of the same erasure that ended before this one started', () => {
    const kept = { participant_index_rows_kept: 1, participants_complete: false }
    const again = jobWith({ job_id: 'er_b', ...kept, created_at: '2026-11-02T10:00:00Z', finished_at: '2026-11-02T10:05:00Z' })
    const earlier = (extra: Record<string, unknown>) => jobWith({ job_id: 'er_a', ...kept, ...extra })
    const cases = [
      earlier({ created_at: '2026-11-02T09:58:00Z', finished_at: '2026-11-02T10:03:00Z' }), // overlapping
      earlier({ value_hash: 'other' }),
      earlier({ status: 'failed' }),
    ]
    expect(cases.map((other) => kinds(again, [again, other]))).toStrictEqual([['participants'], ['participants'], ['participants']])
    // The earlier run itself is never "kept again" by the later one.
    expect(kinds(earlier({}), [again, earlier({})])).toStrictEqual(['participants'])
  })

  it('says when lineage is owed, with its code and the English reason, completed or failed', () => {
    const owed = { lineage_owed: true, incomplete_reason: 'this run failed before its lineage marks',
      lineage_owed_reason: 'failed_before_marks', lineage_owed_mode: 'erase' }
    const step = { kind: 'lineageOwed', code: 'failed_before_marks', reason: owed.incomplete_reason }
    expect(followUps(jobWith(owed))).toStrictEqual([step])
    expect(jobOutcome(jobWith(owed))).toBe('lineageOwed')
    expect(followUps(jobWith({ ...owed, status: 'failed' }))).toStrictEqual([step])
    expect(jobOutcome(jobWith({ ...owed, status: 'failed' }))).toBe('failed')
  })

  it("reads owed lineage whose registries are not complete, or whose owe failed, as the operator's", () => {
    const owed = { lineage_owed: true, incomplete_reason: 'r' }
    expect(jobOutcome(jobWith({ ...owed, review_registries: 'not_backfilled' }))).toBe('operator')
    expect(jobOutcome(jobWith({ ...owed, review_registries: 'incomplete' }))).toBe('operator')
    expect(jobOutcome(jobWith({ ...owed, lineage_owed_reason: 'owe_failed' }))).toBe('operator')
  })

  it('decides from the code when the row has one, and lists the operator\'s owed lineage first', () => {
    const owed = { lineage_owed: true, incomplete_reason: 'r', review_registries: 'complete' }
    expect(jobOutcome(jobWith({ ...owed, lineage_owed_reason: 'not_backfilled' }))).toBe('operator')
    expect(jobOutcome(jobWith({ ...owed, lineage_owed_reason: 'failed_before_marks' }))).toBe('lineageOwed')
    expect(kinds(jobWith({ ...owed, lineage_owed_reason: 'incomplete', participants_complete: false })))
      .toStrictEqual(['lineageOwed', 'participants'])
  })

  it('reads each step of the badge order', () => {
    const accounts = { agent_memory_walked: true, agent_memory_complete: false, agent_memory_accounts_not_erased: 1 }
    const owed = { lineage_owed: true, incomplete_reason: 'r', lineage_owed_reason: 'failed_before_marks' }
    expect([
      jobOutcome(jobWith({ participants_complete: false, project_ids_malformed: 1 })),
      jobOutcome(jobWith({ participants_complete: false, ...accounts })),
      jobOutcome(jobWith({ ...accounts, ...owed })),
      jobOutcome(jobWith({ participants_complete: false, ...owed, lineage_owed_reason: 'incomplete' })),
    ]).toStrictEqual(['operator', 'rerun', 'verifiedAddress', 'operator'])
  })

  it('reads an erasure by the verified address before files to review', () => {
    const accounts = { agent_memory_walked: true, agent_memory_complete: false, agent_memory_accounts_not_erased: 1 }
    expect(jobOutcome(jobWith({ ...accounts, files_needing_review: { count: 1, keys: ['a.csv'] } }))).toBe('verifiedAddress')
  })

  it('asks nothing of a job still running', () => {
    expect(followUps(jobWith({ status: 'running', participants_complete: undefined }))).toStrictEqual([])
    expect(jobOutcome(jobWith({ status: 'running' }))).toBe('running')
  })
})

describe('the files left to review', () => {
  const files = (extra: Record<string, unknown>) => jobWith({ field: 'author', ...extra })

  it('reads a job that kept files for review as such', () => {
    const job = files({ files_needing_review: { count: 1, keys: ['raw/csv_upload/2026/01/01/j.csv'] } })
    expect(kinds(job)).toStrictEqual(['filesToReview'])
    expect(jobOutcome(job)).toBe('filesToReview')
  })

  it('reads a review list that says only more', () => {
    expect(jobOutcome(files({ files_needing_review: { count: 0, keys: [], more: true } }))).toBe('filesToReview')
  })

  it('reads a job with documents not checked', () => {
    expect(jobOutcome(files({ files_not_checked: { count: 1, keys: ['projects/p/product_docs/i/'] } }))).toBe('filesToReview')
  })

  it('reads a not-checked list that says only more', () => {
    expect(jobOutcome(files({ files_not_checked: { count: 0, keys: [], more: true } }))).toBe('filesToReview')
  })

  it('reads a product document counted as not checked', () => {
    expect(jobOutcome(files({ product_docs_not_checked: 2 }))).toBe('filesToReview')
  })

  it('reads files to review after the operator and a rerun, and before lineage a later run makes', () => {
    const kept = { files_needing_review: { count: 1, keys: ['a.csv'] } }
    const owed = { lineage_owed: true, incomplete_reason: 'r', lineage_owed_reason: 'failed_before_marks' }
    expect(jobOutcome(jobWith({ ...kept, ...owed }))).toBe('filesToReview')
    expect(kinds(jobWith({ ...kept, ...owed }))).toStrictEqual(['filesToReview', 'lineageOwed'])
    expect(jobOutcome(jobWith({ ...kept, participants_complete: false }))).toBe('rerun')
    expect(kinds(jobWith({ ...kept, participants_complete: false }))).toStrictEqual(['participants', 'filesToReview'])
  })
})

describe('rerunAdvice', () => {
  it("adds the deployment's own-request condition to the participants step only", () => {
    const deployment = jobWith({})
    expect(rerunAdvice({ kind: 'participants' }, deployment)).toBe('ownRequest')
    expect(rerunAdvice({ kind: 'deploymentProjects' }, deployment)).toBe('plain')
    expect(rerunAdvice({ kind: 'agentMemory' }, deployment)).toBe('plain')
  })

  it("asks a workspace's admins to submit it again from that workspace", () => {
    expect(rerunAdvice({ kind: 'participants' }, jobWith({ workspace_id: WS }))).toBe('workspace')
  })
})

describe('resolvedLater', () => {
  const owing = jobWith({ job_id: 'er_old', field: 'author', lineage_owed: true, incomplete_reason: 'r',
    lineage_owed_reason: 'not_backfilled', review_registries: 'not_backfilled' })
  const later = (extra: Record<string, unknown>) => jobWith({ job_id: 'er_new', field: 'author', value_hash: 'other',
    created_at: '2026-11-02T10:00:00Z', finished_at: '2026-11-02T10:05:00Z', ...extra })
  /** A later run of the same erasure as CLEAN (the same value, field, source and scope). */
  const again = (extra: Record<string, unknown>) =>
    jobWith({ job_id: 'er_again', created_at: '2026-11-02T10:00:00Z', finished_at: '2026-11-02T10:05:00Z', ...extra })

  it("marks an older job's owed lineage as made by a later completed run that replayed it or owed nothing", () => {
    for (const fixed of [later({ lineage_owed_replayed: true }), later({ review_registries: 'complete' })]) {
      expect([resolvedLater(owing, [fixed, owing]), kinds(owing, [fixed, owing])]).toStrictEqual([['lineage'], []])
    }
  })

  it('keeps it owed when the later run owes too, did not finish, or is older', () => {
    const owesToo = later({ lineage_owed: true, incomplete_reason: 'r', review_registries: 'not_backfilled' })
    const running = later({ status: 'running', lineage_owed_replayed: true })
    const older = later({ created_at: '2026-10-01T10:00:00Z', finished_at: '2026-10-01T10:05:00Z', lineage_owed_replayed: true })
    expect([owesToo, running, older].map((job) => kinds(owing, [job, owing]))).toStrictEqual(
      [['lineageOwed'], ['lineageOwed'], ['lineageOwed']])
  })

  it('never marks as made lineage whose owe could not be recorded, or a row with no code', () => {
    const replayed = later({ lineage_owed_replayed: true })
    const unrecorded = jobWith({ ...owing, lineage_owed_reason: 'owe_failed' })
    const noCode = jobWith({ ...owing, lineage_owed_reason: undefined })
    expect([resolvedLater(unrecorded, [replayed, unrecorded]), jobOutcome(unrecorded, [replayed, unrecorded])])
      .toStrictEqual([[], 'operator'])
    expect(resolvedLater(noCode, [replayed, noCode])).toStrictEqual([])
  })

  it('never counts a run started while the older one still ran, nor one of another scope', () => {
    const overlapping = later({ created_at: '2026-11-01T10:02:00Z', review_registries: 'complete' })
    const otherScope = later({ workspace_id: WS, review_registries: 'complete' })
    expect([kinds(owing, [overlapping, owing]), kinds(owing, [otherScope, owing])]).toStrictEqual(
      [['lineageOwed'], ['lineageOwed']])
    const unfinished = jobWith({ ...owing, finished_at: undefined })
    expect(resolvedLater(unfinished, [later({ lineage_owed_replayed: true }), unfinished])).toStrictEqual([])
  })

  it('resolves each rerun on its own, on positive proof from a later run of the same erasure', () => {
    const old = jobWith({ participants_complete: false, deployment_projects_walked: false })
    const fixed = again({})
    expect([resolvedLater(old, [fixed, old]), kinds(old, [fixed, old])])
      .toStrictEqual([['participants', 'deploymentProjects'], []])
    expect(jobOutcome(old, [fixed, old])).toBe('completed')
    const halfway = again({ deployment_projects_walked: undefined })
    expect(kinds(old, [halfway, old])).toStrictEqual(['deploymentProjects'])
  })

  it("resolves the participants when the later run's only open item is an unverified agents' memory account", () => {
    const old = jobWith({ participants_complete: false, agent_memory_walked: false, agent_memory_complete: false })
    const later2 = again({ agent_memory_walked: true, agent_memory_complete: false, agent_memory_accounts_not_erased: 1 })
    expect(resolvedLater(old, [later2, old])).toStrictEqual(['participants'])
    expect(kinds(old, [later2, old])).toStrictEqual(['agentMemory'])
  })

  it("never counts a later run with no agents' memory fields as proof for the agents' memory", () => {
    const old = jobWith({ agent_memory_walked: true, agent_memory_complete: false, agent_memory_accounts_not_erased: 2 })
    expect(kinds(old, [again({}), old])).toStrictEqual(['agentMemoryAccounts'])
    expect(kinds(old, [again({ agent_memory_walked: true, agent_memory_complete: true }), old])).toStrictEqual([])
  })

  it('keeps the rerun when the later erasure is of another value, field, source or scope', () => {
    const old = jobWith({ participants_complete: false })
    const others = [again({ value_hash: 'zzz' }), again({ field: 'author' }), again({ source: 'tickets' }),
      again({ workspace_id: WS })]
    expect(others.map((other) => kinds(old, [other, old]))).toStrictEqual(
      [['participants'], ['participants'], ['participants'], ['participants']])
  })

  it('resolves a malformed row and a kept-again index row by a later clean run, and never by one with a malformed row', () => {
    const malformed = jobWith({ participant_guards_malformed: 1, participants_complete: false })
    expect([kinds(malformed, [again({}), malformed]), kinds(malformed, [again({ participant_guards_malformed: 1 }), malformed])])
      .toStrictEqual([[], ['malformedRows']])
    const first = jobWith({ job_id: 'er_a', created_at: '2026-10-30T10:00:00Z', finished_at: '2026-10-30T10:05:00Z',
      participant_index_rows_kept: 1, participants_complete: false })
    const keptAgain = jobWith({ participant_index_rows_kept: 1, participants_complete: false })
    expect(kinds(keptAgain, [again({}), keptAgain, first])).toStrictEqual([])
  })

  it('says the reruns were done only when none is left, and never for the verified-address step', () => {
    const old = jobWith({ participants_complete: false, deployment_projects_walked: false })
    expect([jobReport(old, [again({ deployment_projects_walked: undefined }), old]).rerunDone,
      jobReport(old, [again({}), old]).rerunDone]).toStrictEqual([false, true])
    const accounts = jobWith({ agent_memory_walked: true, agent_memory_complete: false, agent_memory_accounts_not_erased: 1 })
    const fixed = again({ agent_memory_walked: true, agent_memory_complete: true })
    expect([resolvedLater(accounts, [fixed, accounts]), jobReport(accounts, [fixed, accounts]).rerunDone])
      .toStrictEqual([['agentMemoryAccounts'], false])
  })

  it('keeps lineage owed when the later run read complete registries but owes too', () => {
    const owesToo = later({ review_registries: 'complete', lineage_owed: true, incomplete_reason: 'r',
      lineage_owed_reason: 'failed_before_marks' })
    expect(kinds(owing, [owesToo, owing])).toStrictEqual(['lineageOwed'])
  })

  it('keeps the rerun when the later run of the same erasure is still short on that point', () => {
    const old = jobWith({ participants_complete: false })
    expect(kinds(old, [again({ participants_complete: false }), old])).toStrictEqual(['participants'])
    expect(kinds(old, [again({ participant_index_rows_kept: 1 }), old])).toStrictEqual(['participants'])
  })

  it("marks a failed run's owed lineage as made by a later run that replayed it (the case the code is for)", () => {
    const failed = jobWith({ ...owing, status: 'failed', lineage_owed_reason: 'failed_before_marks',
      review_registries: 'complete' })
    expect(resolvedLater(failed, [later({ lineage_owed_replayed: true }), failed])).toStrictEqual(['lineage'])
    expect(followUps(failed, [later({ lineage_owed_replayed: true }), failed])).toStrictEqual([])
  })

  it('resolves no rerun for a job that did not complete, and nothing for one still running', () => {
    const failed = jobWith({ status: 'failed', participants_complete: false })
    expect(resolvedLater(failed, [again({}), failed])).toStrictEqual([])
    expect(resolvedLater(jobWith({ status: 'running' }), [again({})])).toStrictEqual([])
  })
})

describe('agentMemoryReachNote', () => {
  it("stands on every deployment erasure by email that walked the agents' memory, and no other", () => {
    expect(agentMemoryReachNote(jobWith({ agent_memory_walked: true, agent_memory_complete: true }))).toBe(true)
    expect(agentMemoryReachNote(jobWith({}))).toBe(false)
    expect(agentMemoryReachNote(jobWith({ agent_memory_walked: true, workspace_id: WS }))).toBe(false)
  })
})

describe('jobInScope', () => {
  it("keeps a workspace's own jobs inside it, and the deployment's (no workspace) outside", () => {
    const mine = jobWith({ workspace_id: WS })
    const other = jobWith({ workspace_id: 'ws_01JCJNPR0000000000000000J1' })
    const deployment = jobWith({})
    expect([mine, other, deployment].filter((job) => jobInScope(job, WS))).toStrictEqual([mine])
    expect([mine, other, deployment].filter((job) => jobInScope(job, null))).toStrictEqual([deployment])
  })
})
