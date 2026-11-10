/**
 * The conversation rail for non-technical users (live 5.14 review): relative
 * dates instead of second-precision timestamps, date groups (Today / This week
 * / Older), a title search, and Delete — behind the confirm — on an OPEN
 * conversation too (it only had Close). Leftover conversations are user data:
 * nothing here deletes without the confirm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'

vi.mock('../sessions/sessionsApi', async () => (await import('@test/assistantDoubles')).sessionsApiModule())

import SessionList from './SessionList'
import { deleteSession, listSessions } from '../sessions/sessionsApi'
import { useThreadStore } from '../store/assistantStore'
import { createThreadState } from '../thread/reducer'
import { formatRelativeDate } from '../../utils/dateUtils'
import { groupSessions, matchesTitle } from '../sessions/sessionGroups'
import type { SessionSummary } from '../sessions/schema'
import { rowAction, rowMenuItems } from '@test/assistantRowMenu'

const NOW = Date.parse('2026-10-19T15:00:00')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function summary(id: string, title: string, updatedAt: string): SessionSummary {
  return { id, title, customTitle: null, kind: 'assistant', messageCount: 2, createdAt: '', updatedAt }
}

function iso(msAgo: number, from = Date.now()): string {
  return new Date(from - msAgo).toISOString()
}

function openThread(id: string, title: string): void {
  act(() => {
    useThreadStore.getState().replace({ ...createThreadState(id), messages: [{ id: `${id}-u`, role: 'user', content: title }] })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listSessions).mockResolvedValue([])
  vi.mocked(deleteSession).mockResolvedValue(undefined)
  useThreadStore.getState().reset()
})

describe('formatRelativeDate', () => {
  it.each([
    [iso(20_000, NOW), 'Now'],
    [iso(5 * 60_000, NOW), '5 min. ago'],
    [iso(2 * HOUR, NOW), '2 hr. ago'],
    [new Date('2026-10-18T09:00:00').toISOString(), 'Yesterday'],
    [new Date('2026-10-12T09:00:00').toISOString(), 'Oct 12'],
    [new Date('2025-03-04T09:00:00').toISOString(), 'Mar 4, 2025'],
  ])('reads %s as %s', (value, label) => {
    expect(formatRelativeDate(value, 'en', NOW)).toBe(label)
  })

  it('is empty for a missing or unreadable date', () => {
    expect([formatRelativeDate('', 'en', NOW), formatRelativeDate('soon', 'en', NOW)]).toStrictEqual(['', ''])
  })
})

describe('groupSessions / matchesTitle', () => {
  it('groups by last activity into Today, This week and Older, in that order', () => {
    const items = [
      { id: 'a', updatedAt: iso(HOUR, NOW) },
      { id: 'b', updatedAt: iso(3 * DAY, NOW) },
      { id: 'c', updatedAt: iso(30 * DAY, NOW) },
      { id: 'd', updatedAt: '' },
    ]
    expect(groupSessions(items, NOW).map(({ group, items: inGroup }) => [group, inGroup.map((i) => i.id)]))
      .toStrictEqual([['today', ['a']], ['week', ['b']], ['older', ['c', 'd']]])
  })

  it('matches titles ignoring case and accents; an empty search matches everything', () => {
    expect([matchesTitle('Café prices', 'cafe'), matchesTitle('Radar', 'RAD'), matchesTitle('Radar', 'x'), matchesTitle('Radar', '  ')])
      .toStrictEqual([true, true, false, true])
  })
})

describe('the rail', () => {
  it('labels each date group and shows a relative date per conversation', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      summary('s-1', 'Radar question', iso(30 * 60_000)),
      summary('s-2', 'Old idea', iso(40 * DAY)),
    ])
    render(<SessionList onPick={vi.fn()} />)
    const older = await screen.findByRole('list', { name: 'Older' })
    expect(within(older).getByText('Old idea')).toBeInTheDocument()
    expect(screen.getByText('30 min. ago')).toBeInTheDocument()
    expect(screen.queryByText(/\d{1,2}:\d{2}:\d{2}/u)).not.toBeInTheDocument()
  })

  it('filters open and saved conversations by title, and says when nothing matches', async () => {
    openThread('open-1', 'Pricing complaints')
    vi.mocked(listSessions).mockResolvedValue([summary('s-1', 'Radar question', iso(HOUR)), summary('s-2', 'Pricing in Spain', iso(HOUR))])
    const user = userEvent.setup()
    render(<SessionList onPick={vi.fn()} />)
    await screen.findByText('Radar question')
    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'pricing')
    expect(screen.queryByText('Radar question')).not.toBeInTheDocument()
    expect(screen.getAllByText(/^Pricing/u).map((el) => el.textContent)).toStrictEqual(['Pricing complaints', 'Pricing in Spain'])
    await user.clear(screen.getByRole('searchbox', { name: 'Search conversations' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'zebra')
    expect(screen.getByText('No conversations match your search.')).toBeInTheDocument()
  })

  it('deletes an OPEN conversation only after the confirm, and closes it', async () => {
    openThread('open-1', 'Test chat')
    const user = userEvent.setup()
    render(<SessionList onPick={vi.fn()} />)
    await rowAction(user, 'Test chat', 'Delete', within(screen.getByRole('list', { name: 'Open' })))
    expect(deleteSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete conversation' }))
    await waitFor(() => expect(vi.mocked(deleteSession).mock.calls.map((call) => call[0])).toStrictEqual(['open-1']))
    expect(useThreadStore.getState().slots['open-1']).toBeUndefined()
  })

  it('offers no Delete on an open conversation the server is still answering', async () => {
    openThread('open-1', 'Running chat')
    act(() => {
      useThreadStore.getState().dispatchTo('open-1', { type: 'local/run_requested' })
    })
    render(<SessionList onPick={vi.fn()} />)
    expect(await rowMenuItems(userEvent.setup(), 'Running chat')).not.toContain('Delete')
  })
})
