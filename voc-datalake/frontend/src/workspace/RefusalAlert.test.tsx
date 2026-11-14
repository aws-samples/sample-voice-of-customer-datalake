/**
 * A refused write said in words: nothing without an error, the refusal's own message as an alert, and the generic
 * message with the server's reason for one the table does not name.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ApiError } from '../lib/errors'
import RefusalAlert from './RefusalAlert'
import { MEMBER_REFUSALS } from './workspaceRefusals'

describe('RefusalAlert', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<RefusalAlert error={null} refusals={MEMBER_REFUSALS} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says the refusal the table names', () => {
    render(<RefusalAlert error={new ApiError(403, 'You are no longer an admin of this workspace')} refusals={MEMBER_REFUSALS} />)
    expect(screen.getByRole('alert')).toHaveTextContent('You are no longer an admin of this workspace. Reload the page.')
  })

  it('says any other refusal with the server\'s reason', () => {
    render(<RefusalAlert error={new ApiError(400, 'email is not a valid address')} refusals={MEMBER_REFUSALS} />)
    expect(screen.getByRole('alert')).toHaveTextContent('That did not work: email is not a valid address')
  })
})
