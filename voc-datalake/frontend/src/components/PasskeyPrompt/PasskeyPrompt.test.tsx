/**
 * The one-time passkey offer after sign-in, and the Account section that keeps the same action:
 * who is asked, what each answer records, and how failures read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { useAuthStore } from '../../store/authStore'
import { PasskeyError } from '../../services/passkey'

const mockCanUse = vi.fn<() => boolean>()
const mockHasPasskey = vi.fn<() => Promise<boolean>>()
const mockRegister = vi.fn<() => Promise<void>>()
const mockList = vi.fn<() => Promise<Array<{ id: string; name: string | undefined; createdAt: Date | undefined }>>>()
const mockRemove = vi.fn<(id: string) => Promise<void>>()
vi.mock('../../services/passkeyAuth', () => ({
  canUsePasskeys: () => mockCanUse(),
  passkeyAuth: {
    hasPasskey: () => mockHasPasskey(), register: () => mockRegister(),
    list: () => mockList(), remove: (id: string) => mockRemove(id),
  },
}))

import PasskeyPrompt from './PasskeyPrompt'
import PasskeySection from '../../pages/Account/PasskeySection'

const SUB = 'sub-dana'
const OFFER_KEY = `voc-passkey-offer:${SUB}`
const OFFER = { name: 'Sign in faster with a passkey' }

// The setup's localStorage is a no-op mock: back it with a Map so recorded answers can be read.
const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.mocked(window.localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null)
  vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => { stored.set(key, value) })
  mockCanUse.mockReturnValue(true)
  mockHasPasskey.mockResolvedValue(false)
  mockRegister.mockResolvedValue(undefined)
  mockList.mockResolvedValue([])
  mockRemove.mockResolvedValue(undefined)
  useAuthStore.getState().setUser({ username: 'dana', email: 'dana@example.com', groups: [], sub: SUB })
})

describe('PasskeyPrompt', () => {
  it('offers a passkey to a signed-in person who has none', async () => {
    renderWithQueryClient(<PasskeyPrompt />)
    expect(await screen.findByRole('region', OFFER)).toBeVisible()
  })

  it.each([
    ['already has a passkey', () => { mockHasPasskey.mockResolvedValue(true) }],
    ['answered the offer before in this browser', () => { stored.set(OFFER_KEY, 'declined') }],
  ])('stays hidden when the person %s', async (_label, arrange) => {
    arrange()
    renderWithQueryClient(<PasskeyPrompt />)
    await waitFor(() => expect(screen.queryByRole('region', OFFER)).toBeNull())
  })

  it('never asks Cognito when passkeys cannot be used here', () => {
    mockCanUse.mockReturnValue(false)
    renderWithQueryClient(<PasskeyPrompt />)
    expect(mockHasPasskey).not.toHaveBeenCalled()
  })

  it('"Not now" hides it and records the answer, so it is not asked again', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<PasskeyPrompt />)
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('region', OFFER)).toBeNull()
    expect(stored.get(OFFER_KEY)).toBe('declined')
  })

  it('adding a passkey registers it and records the answer', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<PasskeyPrompt />)
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }))
    await waitFor(() => expect(stored.get(OFFER_KEY)).toBe('added'))
    expect(mockRegister).toHaveBeenCalledExactlyOnceWith()
    // Closed at once, even though the "has a passkey" read would still answer false.
    expect(screen.queryByRole('region', OFFER)).toBeNull()
  })

  it('keeps the offer open with the reason when the browser prompt is cancelled', async () => {
    mockRegister.mockRejectedValue(new PasskeyError('cancelled'))
    const user = userEvent.setup()
    renderWithQueryClient(<PasskeyPrompt />)
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cancelled or timed out/)
    expect(stored.has(OFFER_KEY)).toBe(false)
  })
})

describe('Account PasskeySection', () => {
  it('is absent when passkeys cannot be used here', () => {
    mockCanUse.mockReturnValue(false)
    renderWithQueryClient(<PasskeySection />)
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull()
  })

  it('adds a passkey and says so', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<PasskeySection />)
    await user.click(screen.getByRole('button', { name: 'Add a passkey' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Passkey added/)
  })

  it('says when the account has no passkey yet', async () => {
    renderWithQueryClient(<PasskeySection />)
    expect(await screen.findByText('No passkey on this account yet.')).toBeVisible()
  })

  it('lists the passkeys and removes one after a confirmation', async () => {
    mockList.mockResolvedValue([{ id: 'c1', name: 'iCloud Keychain', createdAt: new Date('2026-10-01T10:00:00Z') }])
    const user = userEvent.setup()
    renderWithQueryClient(<PasskeySection />)
    await user.click(await screen.findByRole('button', { name: 'Remove iCloud Keychain' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(mockRemove).toHaveBeenCalledExactlyOnceWith('c1'))
  })
})
