/**
 * @fileoverview ErasureJobDetails: what a job did beyond its feedback counts (legal basis, Radar
 * reviews, marked artifacts, de-identified board requests and +1s).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErasureJobDetails } from './erasureParts'
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

  it('says nothing about boards when the job touched none', () => {
    render(<ErasureJobDetails job={jobWith({ artifacts_marked: 1 })} />)
    expect(screen.queryByText(/Board requests/)).not.toBeInTheDocument()
    expect(screen.getByText('0 Radar reviews deleted, 1 personas or documents marked')).toBeInTheDocument()
  })
})
