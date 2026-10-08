/**
 * Account → Change password, inline on the page (was the modal's second tab).
 * Cognito-only: no REST call, so nothing to mock beyond authService.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { authService } from '../../services/auth'
import PasswordSection from './PasswordSection'

vi.mock('../../services/auth', () => ({ authService: { changePassword: vi.fn() } }))

const changePassword = vi.mocked(authService.changePassword)

function setup(): UserEvent {
  const user = userEvent.setup()
  render(<PasswordSection />)
  return user
}

const current = () => screen.getByLabelText('Current Password')
const next = () => screen.getByLabelText('New Password')
const confirm = () => screen.getByLabelText('Confirm New Password')
const submit = () => screen.getByRole('button', { name: 'Change Password' })

async function fill(user: UserEvent, a: string, b: string, c: string): Promise<void> {
  await user.type(current(), a)
  await user.type(next(), b)
  await user.type(confirm(), c)
}

beforeEach(() => changePassword.mockReset())

describe('PasswordSection', () => {
  it('is a labelled region with three labelled password inputs and the right autocomplete hints', () => {
    setup()
    expect(screen.getByRole('region', { name: 'Change Password' })).toBeInTheDocument()
    expect([current(), next(), confirm()].map((input) => input.getAttribute('type'))).toStrictEqual(['password', 'password', 'password'])
    expect([current(), next(), confirm()].map((input) => input.getAttribute('autocomplete'))).toStrictEqual(['current-password', 'new-password', 'new-password'])
  })

  it('keeps submit disabled until every field is filled', async () => {
    const user = setup()
    expect(submit()).toBeDisabled()
    await user.type(current(), 'x')
    await user.type(next(), 'y')
    expect(submit()).toBeDisabled()
    await user.type(confirm(), 'z')
    expect(submit()).toBeEnabled()
  })

  it('refuses mismatched passwords with an alert and never calls Cognito', async () => {
    const user = setup()
    await fill(user, 'oldpass', 'newpass123', 'different')
    await user.click(submit())
    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match')
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('refuses a password under 8 characters', async () => {
    const user = setup()
    await fill(user, 'oldpass', 'short', 'short')
    await user.click(submit())
    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters')
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('changes the password, confirms it and clears the fields', async () => {
    changePassword.mockResolvedValue(undefined)
    const user = setup()
    await fill(user, 'oldpassword', 'newpassword123', 'newpassword123')
    await user.click(submit())
    expect(changePassword).toHaveBeenCalledWith('oldpassword', 'newpassword123')
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed successfully!')
    // The three password inputs are empty again (the checkbox's value is "on", so it is not counted).
    expect(screen.getAllByDisplayValue('')).toStrictEqual([current(), next(), confirm()])
  })

  it('submits with Enter from the keyboard', async () => {
    changePassword.mockResolvedValue(undefined)
    const user = setup()
    await fill(user, 'oldpassword', 'newpassword123', 'newpassword123{Enter}')
    expect(changePassword).toHaveBeenCalledWith('oldpassword', 'newpassword123')
  })

  it('translates a Cognito "Incorrect" error and keeps other messages', async () => {
    changePassword.mockRejectedValueOnce(new Error('Incorrect username or password.'))
    const user = setup()
    await fill(user, 'wrongpass', 'newpassword123', 'newpassword123')
    await user.click(submit())
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect')

    changePassword.mockRejectedValueOnce(new Error('Attempt limit exceeded'))
    await user.click(submit())
    expect(await screen.findByText('Attempt limit exceeded')).toBeInTheDocument()

    changePassword.mockRejectedValueOnce('not an error')
    await user.click(submit())
    expect(await screen.findByText('Failed to change password')).toBeInTheDocument()
  })

  it('reveals and hides all three passwords with one labelled checkbox', async () => {
    const user = setup()
    const toggle = screen.getByRole('checkbox', { name: 'Show passwords' })
    await user.click(toggle)
    for (const input of [current(), next(), confirm()]) expect(input).toHaveAttribute('type', 'text')
    await user.click(toggle)
    for (const input of [current(), next(), confirm()]) expect(input).toHaveAttribute('type', 'password')
  })
})
