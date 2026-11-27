/**
 * @fileoverview ErasureJobDetails: what a job did beyond its feedback counts (legal basis, Radar
 * reviews, marked artifacts, de-identified board requests and +1s).
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ErasureJobDetails, ErasureStatusBadge, ErasureWorkspaceItems } from './erasureParts'
import { normalizeErasureJob } from '../../api/sourceProfilesApi'
import type { ErasureJob } from '../../api/sourceProfilesApi'
import { jobReport } from './erasureOutcome'

/** The parts as a row renders them: the report computed once, of the job by itself. */
function Details({ job }: Readonly<{ job: ErasureJob }>) {
  return <ErasureJobDetails job={job} report={jobReport(job)} />
}
function Badge({ job }: Readonly<{ job: ErasureJob }>) {
  return <ErasureStatusBadge report={jobReport(job)} />
}

function jobWith(extra: Record<string, unknown>) {
  const job = normalizeErasureJob({ job: { job_id: 'er_1', status: 'completed', field: 'email', value_hash: 'abc', ...extra } })
  if (job === null) throw new Error('fixture job did not normalize')
  return job
}

describe('ErasureJobDetails', () => {
  it('shows the board requests and +1s an erasure by email de-identified', () => {
    render(<Details job={jobWith({ board_items_deidentified: 5 })} />)
    expect(screen.getByText('Board requests and +1s de-identified: 5')).toBeInTheDocument()
  })

  it('shows the workspace memberships an erasure by email de-identified', () => {
    render(<Details job={jobWith({ member_rows_deidentified: 3 })} />)
    expect(screen.getByText('Workspace memberships de-identified: 3')).toBeInTheDocument()
  })

  it('shows how many of the deleted reviews were a workspace\'s, and nothing when none were', () => {
    const { unmount } = render(<ErasureWorkspaceItems job={jobWith({ deleted_items: 3, deleted_workspace_items: 2 })} />)
    expect(screen.getByText('Deleted reviews in workspaces: 2')).toBeInTheDocument()
    unmount()
    render(<ErasureWorkspaceItems job={jobWith({ deleted_items: 3 })} />)
    expect(screen.queryByText(/in workspaces/)).not.toBeInTheDocument()
  })

  it('lists kept uploaded files and S3 import originals folders apart', () => {
    render(<Details job={jobWith({ files_needing_review: {
      count: 2, keys: ['raw/csv_upload/2026/01/01/j.csv', 'ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/s3_import/'],
    } })} />)
    expect(screen.getByText(/Uploaded files kept because they also hold rows that were not erased: 1/)).toBeInTheDocument()
    expect(screen.getByText(/S3 import originals folders kept that may hold erased rows: 1/)).toBeInTheDocument()
    expect(screen.getByText('ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/s3_import/')).toBeInTheDocument()
  })

  it('lists the documents that hold the address apart from uploads and folders, and says when the list is cut', () => {
    render(<Details job={jobWith({ files_needing_review: {
      count: 200, more: true, keys: ['raw/csv_upload/2026/01/01/j.csv', 'ws/ws_1/projects/p_1/product_docs/brief.md'],
    } })} />)
    const documents = screen.getByRole('list', { name: /^Documents that hold the address \(product documents, library items\): 1/ })
    expect(within(documents).getByText('ws/ws_1/projects/p_1/product_docs/brief.md')).toBeInTheDocument()
    expect(screen.getByText(/^Uploaded files kept because they also hold rows that were not erased: 1/)).toBeInTheDocument()
    // The cut note describes each list it cuts (q-13).
    expect(documents).toHaveAccessibleDescription('Only the first 2 items to review are listed: the job holds more. Check the rest by hand.')
  })

  it('lists the documents the erasure could not check with their total, and its own cut note', () => {
    render(<Details job={jobWith({
      product_docs_not_checked: 3,
      files_not_checked: { count: 1, more: true, keys: ['ws/ws_1/projects/p_1/product_docs/img_1/'] },
    })} />)
    const list = screen.getByRole('list', { name: /^3 documents could not be checked for the address/ })
    expect(within(list).getByText('ws/ws_1/projects/p_1/product_docs/img_1/')).toBeInTheDocument()
    expect(list).toHaveAccessibleDescription('1 of 3 listed: the job keeps only the first ones. Check the rest by hand.')
    expect(screen.queryByText(/^Product documents not checked/)).not.toBeInTheDocument()
  })

  it('says one document in the singular, and a cut list with no total as only the first ones', () => {
    render(<Details job={jobWith({
      files_not_checked: { count: 1, more: true, keys: ['ws/ws_1/projects/p_1/product_docs/img_1/'] },
    })} />)
    const list = screen.getByRole('list', { name: /^1 document could not be checked for the address/ })
    expect(list).toHaveAccessibleDescription('Only the first document not checked is listed: the job holds more. Check the rest by hand.')
  })

  it('shows no empty list when the counter names documents the job kept no key of', () => {
    render(<Details job={jobWith({ field: 'author', product_docs_not_checked: 2 })} />)
    expect(screen.getByText(/^2 documents could not be checked for the address/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: /could not be checked/ })).not.toBeInTheDocument()
  })

  it('shows every counter the job row holds above 0, once', () => {
    render(<Details job={jobWith({
      participants_erased: 4, participants_not_erased: 1, deleted_export_objects: 2, project_rows_deidentified: 5,
      form_test_responses_deleted: 6, agent_memory_people_erased: 7, agent_memory_people_refused: 8,
      agent_memory_accounts_not_erased: 9, engineering_rows_marked: 10,
    })} />)
    for (const text of ['Participants erased: 4', 'Participants not erased: 1', 'Export objects deleted: 2',
      'Project rows de-identified: 5', 'Form test responses deleted: 6', "People erased from the agents' memory: 7",
      "People the agents' memory will no longer keep: 8", 'Engineering run rows updated: 10']) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    // The unverified accounts are a follow-up, not a second counter (q2-7).
    expect(screen.queryByText(/^Agents' memory accounts with this address not erased/)).not.toBeInTheDocument()
  })

  it('says what to do when a completed erasure by email must run again, by scope', () => {
    const { unmount } = render(<Details job={jobWith({ participants_complete: false, deployment_projects_walked: true,
      participant_index_rows_kept: 2 })} />)
    const steps = screen.getByRole('list', { name: 'This erasure needs a follow-up' })
    expect(within(steps).getByText(/^Not every participant record that holds this address was erased\./)).toHaveTextContent(
      "2 index rows still hold the address. If this deployment has its own erasure request for this address, submit this erasure again with the person's address and legal basis (the job keeps only a hash of the address); otherwise the workspace that received the request submits it from there. If a rerun keeps a record again, ask the deployment's operator.")
    unmount()
    render(<Details job={jobWith({ participants_complete: false, workspace_id: 'ws_1' })} />)
    expect(screen.getByText(/^Not every participant record/)).toHaveTextContent(
      "Submit this erasure again from this workspace with the person's address and legal basis")
  })

  it("gives the deployment's projects and the agents' memory the plain rerun, and malformed rows to the operator", () => {
    render(<Details job={jobWith({
      participants_complete: false, deployment_projects_walked: false, agent_memory_walked: false, agent_memory_complete: false,
      participant_guards_malformed: 2, participant_index_rows_kept: 1,
    })} />)
    const plain = "Submit this erasure again with the person's address and legal basis (the job keeps only a hash of the address)."
    expect(screen.getByText(/^The deployment's own projects were not searched for this address\./)).toHaveTextContent(plain)
    expect(screen.getByText(/^The engineering agents' memory was not fully erased for this address\./)).toHaveTextContent(plain)
    expect(screen.getByText(/^2 malformed participant rows were skipped\./)).toHaveTextContent(
      "Ask the deployment's operator to mend each row, or to erase by id the person it names, then submit this erasure again: a rerun alone does not mend it.")
    expect(screen.queryByText(/^Not every participant record/)).not.toBeInTheDocument()
  })

  it("asks for an erasure by each account's verified address, and says what an address cannot reach", () => {
    render(<Details job={jobWith({
      participants_complete: true, deployment_projects_walked: true, agent_memory_walked: true, agent_memory_complete: false,
      agent_memory_accounts_not_erased: 2,
    })} />)
    expect(screen.getByText(/^2 accounts hold this address unverified/)).toHaveTextContent(
      "In Users, confirm each account is the person's and verify its email, or, if it is not theirs, change or remove the address on it; then submit this erasure again with the same address and legal basis.")
    expect(screen.getByText(/^An engineering agents' account whose email has changed/)).toHaveTextContent(
      "is not reached by the address: in Users, confirm the account is the person's and verify its email")
  })

  it('names skipped malformed project ids for the operator', () => {
    render(<Details job={jobWith({ field: 'author', project_ids_malformed: 1 })} />)
    expect(screen.getByText(/^1 malformed project id was skipped/)).toHaveTextContent("Ask the deployment's operator to look at it.")
  })

  it('says lineage is owed in words from its code, and falls back to the English reason of an older row', () => {
    const { unmount } = render(<Details job={jobWith({
      participants_complete: true, deployment_projects_walked: true, review_registries: 'not_backfilled',
      lineage_owed: true, incomplete_reason: 'english words', lineage_owed_reason: 'not_backfilled', lineage_owed_mode: 'erase',
    })} />)
    expect(screen.getByText(/^The personas and documents that cite the erased reviews are not marked yet/)).toHaveTextContent(
      "The review registries are not backfilled: ask the deployment's operator to run scripts/projects/backfill_review_registries.py --apply. Then the next erasure of the deployment, or the next daily retention window, makes them on its own.")
    expect(screen.getByText('Review registries: not backfilled yet')).toBeInTheDocument()
    unmount()
    render(<Details job={jobWith({ field: 'author', lineage_owed: true, incomplete_reason: 'english words' })} />)
    expect(screen.getByText(/^The personas and documents/)).toHaveTextContent('What happens next and what to do: english words')
  })

  it('says when a run replayed what an earlier run owed, with no follow-up', () => {
    render(<Details job={jobWith({ field: 'author', review_registries: 'complete', lineage_owed_replayed: true })} />)
    expect(screen.getByText('This run also made the lineage marks an earlier run owed.')).toBeInTheDocument()
    expect(screen.queryByText(/^Review registries/)).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'This erasure needs a follow-up' })).not.toBeInTheDocument()
  })

  it('points at the lists when a job left files to review', () => {
    render(<Details job={jobWith({ field: 'author', files_needing_review: { count: 1, keys: ['a.csv'] } })} />)
    expect(within(screen.getByRole('list', { name: 'This erasure needs a follow-up' }))
      .getByText('Some files could not be erased automatically: review the lists below by hand.')).toBeInTheDocument()
  })

  it('says what a later job finished, and drops it from the follow-ups', () => {
    const old = jobWith({ field: 'author', created_at: '2026-11-01', finished_at: '2026-11-01T01:00',
      lineage_owed: true, incomplete_reason: 'r', lineage_owed_reason: 'not_backfilled', review_registries: 'not_backfilled' })
    const later = jobWith({ job_id: 'er_2', field: 'author', created_at: '2026-11-02', finished_at: '2026-11-02T01:00',
      lineage_owed_replayed: true })
    render(<ErasureJobDetails job={old} report={jobReport(old, [later, old])} />)
    expect(screen.getByText('A later run made the lineage marks this run owed.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'This erasure needs a follow-up' })).not.toBeInTheDocument()
  })

  it("says on a failed job whose owed lineage a later run made that the erasure itself still failed", () => {
    const failed = jobWith({ field: 'author', status: 'failed', created_at: '2026-11-01', finished_at: '2026-11-01T01:00',
      lineage_owed: true, incomplete_reason: 'r', lineage_owed_reason: 'failed_before_marks', review_registries: 'complete' })
    const later = jobWith({ job_id: 'er_2', field: 'author', created_at: '2026-11-02', finished_at: '2026-11-02T01:00',
      lineage_owed_replayed: true })
    render(<ErasureJobDetails job={failed} report={jobReport(failed, [later, failed])} />)
    expect(screen.getByText(/^A later run made the lineage marks this run owed/)).toHaveTextContent(
      'the erasure itself still failed: see its error.')
  })

  it('says nothing about boards or folders when the job touched none', () => {
    render(<Details job={jobWith({ artifacts_marked: 1 })} />)
    expect(screen.queryByText(/Board requests/)).not.toBeInTheDocument()
    expect(screen.queryByText(/originals folders/)).not.toBeInTheDocument()
    expect(screen.getByText('0 Radar reviews deleted, 1 personas or documents marked')).toBeInTheDocument()
  })
})

describe('ErasureStatusBadge', () => {
  it('reads a completed job that needs a follow-up as such, never as plain "Completed"', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ field: 'author' }, 'Completed'],
      [{ field: 'email', participants_complete: false }, 'Completed: run again'],
      [{ field: 'author', lineage_owed: true, incomplete_reason: 'r', review_registries: 'complete' }, 'Completed: lineage owed'],
      [{ field: 'email', participants_complete: false, participant_guards_malformed: 1 }, 'Completed: needs the operator'],
      [{ field: 'email', participants_complete: true, deployment_projects_walked: true, agent_memory_walked: true,
        agent_memory_complete: false, agent_memory_accounts_not_erased: 1 }, 'Completed: check the account in Users'],
      [{ field: 'author', files_not_checked: { count: 0, keys: [], more: true } }, 'Completed: files to review'],
      [{ field: 'author', status: 'failed', lineage_owed: true, incomplete_reason: 'r' }, 'Failed'],
    ]
    for (const [extra, label] of cases) {
      const { unmount } = render(<Badge job={jobWith({ status: 'completed', ...extra })} />)
      expect(screen.getByText(label, { exact: true })).toBeInTheDocument()
      unmount()
    }
  })

  it('reads files to review in the warning style', () => {
    render(<Badge job={jobWith({ field: 'author', product_docs_not_checked: 1 })} />)
    expect(screen.getByText('Completed: files to review')).toHaveClass('badge-warn')
  })
})
