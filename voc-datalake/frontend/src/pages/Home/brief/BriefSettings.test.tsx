/**
 * @fileoverview The morning brief settings form (Account → Morning brief): the
 * only the subscribe call to action until the reader subscribes, what each
 * control saves, and the email confirmation state; and Home's one-click
 * subscribe card (no settings fields, a link to Account).
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { DEFAULT_PREFERENCES } from '../../../api/briefingApi'
import BriefSettings, { BriefSubscribe } from './BriefSettings'
import { browserTimeZone } from './briefCards'
import type { BriefPreferences } from '../../../api/briefingApi'
import type { BriefPreferencesResult } from './useBriefPreferences'

function settings(preferences: Partial<BriefPreferences> = {}, save = vi.fn()): BriefPreferencesResult {
  return { preferences: { ...DEFAULT_PREFERENCES, ...preferences }, isLoading: false, save,
    isSaving: false, saveFailed: false }
}

const ON = { enabled: true, hour: 7, time_zone: 'Europe/Paris' }

function renderSettings(result: BriefPreferencesResult) {
  return renderWithQueryClient(<BriefSettings settings={result} />)
}

describe('subscribe', () => {
  it('asks for the hour and subscribes in the browser time zone, following the app language', async () => {
    const save = vi.fn()
    renderSettings(settings({}, save))
    expect(screen.getByRole('heading', { name: 'Subscribe to the morning brief' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Time to send' }), '6')
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(save).toHaveBeenCalledWith({ enabled: true, hour: 6, time_zone: browserTimeZone(), language: 'en', language_source: 'ui' })
  })

  it('keeps a brief language the reader chose before subscribing', async () => {
    const save = vi.fn()
    renderSettings(settings({ language: 'ja', language_source: 'chosen' }, save))
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(save).toHaveBeenCalledWith({ enabled: true, hour: 8, time_zone: browserTimeZone() })
  })

  it('says it is loading while the preferences load, with no form yet', () => {
    renderSettings({ ...settings(), isLoading: true })
    expect([screen.getByText('Loading your brief settings...').isConnected, screen.queryByRole('switch')]).toStrictEqual([true, null])
  })
})

describe("Home's one-click subscribe", () => {
  function renderHomeCard(result: BriefPreferencesResult, onClose: () => void = vi.fn()) {
    return renderWithQueryClient(<TestRouter><BriefSubscribe settings={result} onClose={onClose} /></TestRouter>)
  }

  it('closes with its X (the caller stores it)', async () => {
    const onClose = vi.fn()
    renderHomeCard(settings(), onClose)
    await userEvent.click(screen.getByRole('button', { name: 'Close: Subscribe to the morning brief' }))
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
  })

  it('subscribes in one click at the default hour, in the browser time zone', async () => {
    const save = vi.fn()
    renderHomeCard(settings({}, save))
    await userEvent.click(screen.getByRole('button', { name: 'Subscribe' }))
    expect(save).toHaveBeenCalledWith({ enabled: true, hour: DEFAULT_PREFERENCES.hour, time_zone: browserTimeZone(), language: 'en', language_source: 'ui' })
  })

  it('has no settings fields, and says when it will arrive', () => {
    renderHomeCard(settings({ hour: 7 }))
    expect([screen.queryByRole('combobox'), screen.queryByRole('switch'), screen.queryByRole('textbox')]).toStrictEqual([null, null, null])
    expect(screen.getByText(/every morning at 7:00/)).toHaveTextContent(browserTimeZone())
  })

  it('links to Account → Morning brief to customise it', () => {
    renderHomeCard(settings())
    expect(screen.getByRole('link', { name: 'Customise in Account' })).toHaveAttribute('href', '/account?tab=briefing')
  })
})

describe('before subscribing', () => {
  it('shows the Subscribe control and the brief language: no on/off switch, no other settings', () => {
    renderSettings(settings())
    expect([
      screen.getAllByRole('combobox').length,
      screen.queryByRole('switch'),
      screen.queryByRole('textbox'),
    ]).toStrictEqual([2, null, null])
  })

  it('defaults the brief language to "Same as the app"', () => {
    renderSettings(settings())
    expect(screen.getByRole('combobox', { name: 'Brief language' })).toHaveDisplayValue('Same as the app (English)')
  })

  it('saves a picked language as an explicit choice', async () => {
    const save = vi.fn()
    renderSettings(settings({}, save))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Brief language' }), 'pl')
    expect(save).toHaveBeenCalledWith({ language: 'pl', language_source: 'chosen' })
  })
})

describe('brief settings', () => {
  it('shows no Subscribe button once subscribed', () => {
    renderSettings(settings(ON))
    expect([screen.queryByRole('button', { name: 'Subscribe' }), screen.getByRole('switch', { name: 'Morning brief on' }).isConnected])
      .toStrictEqual([null, true])
  })

  it('turns the brief off', async () => {
    const save = vi.fn()
    renderSettings(settings(ON, save))
    await userEvent.click(screen.getByRole('switch', { name: 'Morning brief on' }))
    expect(save).toHaveBeenCalledWith({ enabled: false, time_zone: browserTimeZone() })
  })

  it('changes the language', async () => {
    const save = vi.fn()
    renderSettings(settings(ON, save))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Brief language' }), 'de')
    expect(save).toHaveBeenCalledWith({ language: 'de', language_source: 'chosen' })
  })

  it('shows a chosen language, and "Same as the app" goes back to following the app', async () => {
    const save = vi.fn()
    renderSettings(settings({ ...ON, language: 'ja', language_source: 'chosen' }, save))
    const picker = screen.getByRole('combobox', { name: 'Brief language' })
    expect(picker).toHaveDisplayValue('日本語')
    await userEvent.selectOptions(picker, 'Same as the app (English)')
    expect(save).toHaveBeenCalledWith({ language: 'en', language_source: 'ui' })
  })

  it('saves the custom instructions, trimmed', async () => {
    const save = vi.fn()
    renderSettings(settings(ON, save))
    await userEvent.type(screen.getByRole('textbox', { name: 'What I want in my brief' }), '  Focus on delivery  ')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(save).toHaveBeenCalledWith({ instructions: 'Focus on delivery' })
  })

  it('refuses instructions over 2,000 characters before saving', async () => {
    renderSettings(settings({ ...ON, instructions: 'x'.repeat(2001) }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('asks the reader to confirm the AWS email while the subscription is pending', () => {
    renderSettings(settings({ ...ON, email: true, email_status: 'pending' }))
    expect(screen.getByRole('status')).toHaveTextContent('confirm the email from AWS')
  })

  it('says when the email is confirmed', async () => {
    const save = vi.fn()
    renderSettings(settings({ ...ON, email: true, email_status: 'confirmed' }, save))
    expect(screen.getByRole('status')).toHaveTextContent('Email confirmed.')
    await userEvent.click(screen.getByRole('switch', { name: 'Email me the brief' }))
    expect(save).toHaveBeenCalledWith({ email: false })
  })
})
