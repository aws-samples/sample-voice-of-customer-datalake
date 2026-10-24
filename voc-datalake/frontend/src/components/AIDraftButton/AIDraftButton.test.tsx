/**
 * @fileoverview AIDraftButton: one label pattern, loading, gated and failed look for every AI draft.
 * @module components/AIDraftButton
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AIDraftButton from './AIDraftButton'

type Props = Parameters<typeof AIDraftButton>[0]

function renderButton(overrides: Partial<Props> = {}) {
  const onClick = vi.fn()
  render(
    <AIDraftButton subject="title and description" hasText={false} busy={false} onClick={onClick} hint="Uses feedback" {...overrides} />,
  )
  return { onClick, button: screen.getByRole('button') }
}

describe('AIDraftButton', () => {
  it('offers a draft into empty fields, named with what it writes', async () => {
    const { onClick, button } = renderButton()

    expect(button).toHaveAccessibleName('Draft with AI — title and description')
    expect(button).toHaveAttribute('title', 'Uses feedback')
    await userEvent.setup().click(button)
    expect(onClick).toHaveBeenCalledExactlyOnceWith()
  })

  it('offers to improve fields that hold text', () => {
    const { button } = renderButton({ hasText: true })

    expect(button).toHaveAccessibleName('Improve with AI — title and description')
  })

  it('shows "Drafting…" and waits while a draft runs', () => {
    const { button } = renderButton({ busy: true, hasText: true })

    expect(button).toHaveAccessibleName('Drafting… — title and description')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('says why it is gated, visibly and as its description', () => {
    const { button } = renderButton({ disabledReason: 'Add a title and description first' })

    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription('Add a title and description first')
    expect(screen.getByText('Add a title and description first')).toBeVisible()
  })

  it('does nothing when clicked while gated', async () => {
    const { onClick, button } = renderButton({ disabledReason: 'Add a title and description first' })

    await userEvent.setup().click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('announces a failed draft and stays usable', () => {
    const { button } = renderButton({ error: 'The draft failed.' })

    expect(screen.getByRole('alert')).toHaveTextContent('The draft failed.')
    expect(button).toHaveAccessibleDescription('The draft failed.')
    expect(button).toBeEnabled()
  })
})
