/**
 * @fileoverview LoadFailed: an announced failure with a retry that waits for its refetch.
 * @module components/LoadFailed
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LoadFailed from './LoadFailed'

describe('LoadFailed', () => {
  it('is an alert naming the failure, and its button retries', async () => {
    const onRetry = vi.fn()
    render(<LoadFailed onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent('This could not be loaded. Check your connection and try again.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))

    expect(onRetry).toHaveBeenCalledExactlyOnceWith()
  })

  it('disables the retry while a refetch is in flight', () => {
    render(<LoadFailed onRetry={vi.fn()} retrying />)

    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
  })

  it('says what failed when the page names it', () => {
    render(<LoadFailed onRetry={vi.fn()} message="Agents couldn't be loaded." />)

    expect(screen.getByRole('alert')).toHaveTextContent("Agents couldn't be loaded.")
    expect(screen.getByRole('alert')).not.toHaveTextContent('Check your connection')
  })
})
