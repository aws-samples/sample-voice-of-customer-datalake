/**
 * @fileoverview ErasureJobDetails: what a job did beyond its feedback counts (legal basis, Radar
 * reviews, marked artifacts, de-identified board requests and +1s).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErasureJobDetails, ErasureWorkspaceItems } from './erasureParts'
import { normalizeErasureJob } from '../../api/sourceProfilesApi'

function jobWith(extra: Record<string, unknown>) {
  const job = normalizeErasureJob({ job: { job_id: 'er_1', status: 'completed', field: 'email', value_hash: 'abc', ...extra } })
  if (job === null) throw new Error('fixture job did not normalize')
  return job
}

describe('ErasureJobDetails', () => {
  it('shows the board requests and +1s an erasure by email de-identified', () => {
    render(<ErasureJobDetails job={jobWith({ board_items_deidentified: 5 })} />)
    expect(screen.getByText('Board requests and +1s de-identified: 5')).toBeInTheDocument()
  })

  it('shows the workspace memberships an erasure by email de-identified', () => {
    render(<ErasureJobDetails job={jobWith({ member_rows_deidentified: 3 })} />)
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
    render(<ErasureJobDetails job={jobWith({ files_needing_review: {
      count: 2, keys: ['raw/csv_upload/2026/01/01/j.csv', 'ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/s3_import/'],
    } })} />)
    expect(screen.getByText(/Uploaded files kept because they also hold rows that were not erased: 1/)).toBeInTheDocument()
    expect(screen.getByText(/S3 import originals folders kept that may hold erased rows: 1/)).toBeInTheDocument()
    expect(screen.getByText('ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/s3_import/')).toBeInTheDocument()
  })

  it('says nothing about boards or folders when the job touched none', () => {
    render(<ErasureJobDetails job={jobWith({ artifacts_marked: 1 })} />)
    expect(screen.queryByText(/Board requests/)).not.toBeInTheDocument()
    expect(screen.queryByText(/originals folders/)).not.toBeInTheDocument()
    expect(screen.getByText('0 Radar reviews deleted, 1 personas or documents marked')).toBeInTheDocument()
  })
})
