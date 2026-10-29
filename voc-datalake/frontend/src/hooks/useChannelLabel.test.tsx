/**
 * A feedback-form review's channel reads as the form's name, never "Form c8ee14b3" (5.34.00).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'

const getFeedbackForms = vi.fn<() => Promise<unknown>>()
vi.mock('../api/client', () => ({ api: { getFeedbackForms: () => getFeedbackForms() } }))

import { useChannelLabel } from './useChannelLabel'

function createQueryWrapper() {
  const client = createTestQueryClient()
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  getFeedbackForms.mockReset()
  getFeedbackForms.mockResolvedValue({ success: true, forms: [{ form_id: 'c8ee14b3', name: 'Checkout survey' }, { form_id: 'blank', name: '  ' }] })
})

describe('useChannelLabel', () => {
  it('names a feedback-form channel after its form', async () => {
    const { result } = renderHook(() => useChannelLabel('form_c8ee14b3', 'feedback_form'), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(result.current).toBe('Checkout survey'))
  })

  it('keeps the humanised id for a form with no name or one since deleted', async () => {
    const { result } = renderHook(() => useChannelLabel('form_gone', 'feedback_form'), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(getFeedbackForms).toHaveBeenCalledTimes(1))
    expect(result.current).toBe('Form gone')
  })

  it('reads no forms for any other channel', () => {
    const { result } = renderHook(() => useChannelLabel('google_play', 'app_review'), { wrapper: createQueryWrapper() })
    expect(result.current).toBe('Google play')
    expect(getFeedbackForms).not.toHaveBeenCalled()
  })
})
