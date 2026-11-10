/**
 * A submission's category reads as its label (live finding: `software_firmware`
 * was shown verbatim in the form submissions list).
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { render } from '@test/test-utils'

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormSubmissions: () => Promise.resolve({
      success: true,
      submissions: [{
        feedback_id: 'f1', original_text: 'The update bricked it', rating: 2, sentiment_label: 'negative',
        category: 'software_firmware', persona_name: null, created_at: '2026-01-01T10:00:00Z',
      }],
      count: 1,
    }),
    getCategoriesConfig: () => Promise.resolve({ categories: [] }),
  },
}))

import SubmissionsModal from './SubmissionsModal'

describe('SubmissionsModal', () => {
  it('shows a category label, never the stored id', async () => {
    render(<SubmissionsModal formId="form_1" formName="Website" onClose={vi.fn()} />)

    expect(await screen.findByText('Software firmware')).toBeInTheDocument()
    expect(screen.queryByText('software_firmware')).not.toBeInTheDocument()
  })
})
