/**
 * @fileoverview The brief on Home: cards, act buttons (prefill a new assistant
 * conversation, never send), dismiss, "Things to do", seen marking, and Refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { NO_BRIEF } from '../../../api/briefingApi'
import { useConfigStore } from '../../../store/configStore'
import type { BriefCard } from '../../../api/briefingApi'
import type { BriefResult } from './useBrief'
import type { OpenAssistantRequest } from '../../../assistant/store/openAssistant'

const assistant = vi.hoisted(() => ({ openAssistant: vi.fn<(request: OpenAssistantRequest) => void>() }))
vi.mock('../../../assistant/store/openAssistant', () => assistant)
const SMALL_WEEK = { period_days: 7, total_feedback: 12, avg_sentiment: 0.1, urgent_count: 2 }
const summary = vi.hoisted(() => ({ current: { period_days: 7, total_feedback: 12, avg_sentiment: 0.1, urgent_count: 2 } }))
vi.mock('../../../api/client', () => ({
  api: { getSummary: () => Promise.resolve(summary.current) },
}))

const { default: MorningBrief } = await import('./MorningBrief')
const { RefreshButton } = await import('./BriefHeader')
const { default: MetricTiles } = await import('./MetricTiles')
const { UNDO_TIMEOUT_MS } = await import('./UndoNotice')

function card(id: string, kind: string, extra: Partial<BriefCard> = {}): BriefCard {
  return { id, kind, layer: 'org', severity: 'info', title: `${id} title`, body: `${id} body`, facts: {}, actions: [],
    feedback_ids: [], urls: [], ...extra }
}

const TRENDING = card('trending_topic_aaaaaaaaaaaaaaaa', 'trending_topic', {
  severity: 'alert', feedback_ids: ['f1', 'f2'], facts: { quotes: [{ feedback_id: 'f1', text: 'Parcel lost twice' }] },
})
const NOTE = card('personal_note_bbbbbbbbbbbbbbbb', 'personal_note', {
  layer: 'personal', actions: [{ label: 'Ask the assistant', prompt: 'Which issues hurt my objective?' }],
})
const TODO = card('todo_mcp_tokens_cccccccccccccccc', 'todo_mcp_tokens', { layer: 'personal' })

function result(overrides: Partial<BriefResult['brief']> = {}, setCardStates = vi.fn()): BriefResult {
  return {
    brief: { ...NO_BRIEF, status: 'ready', day: '2026-10-17', cards: [TRENDING, NOTE, TODO], card_state: {}, ...overrides },
    generating: false, refresh: vi.fn(), refreshOutcome: 'idle', setCardStates,
  }
}

/** The `<li>` of the card titled `title`. */
function cardItem(title: string): HTMLElement {
  const item = screen.getByRole('heading', { name: title }).closest('li')
  if (item === null) throw new Error(`no card item for ${title}`)
  return item
}

function renderBrief(value: BriefResult) {
  return renderWithQueryClient(<TestRouter><MorningBrief result={value} /></TestRouter>)
}

beforeEach(() => {
  summary.current = SMALL_WEEK
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
})

describe('brief cards', () => {
  it('labels each card by what it is (not "Note"/"Alert"), with its quotes and the reviews behind it', () => {
    renderBrief(result())
    const item = cardItem(TRENDING.title)
    expect(within(item).getByText('Trending')).toHaveClass('badge-danger')
    expect(within(cardItem(NOTE.title)).getByText('Update')).toBeInTheDocument()
    expect(within(item).getByText('Parcel lost twice')).toBeInTheDocument()
    expect(within(item).getByText('Reviews behind this card: 2')).toBeInTheDocument()
  })

  it('links each review behind a card to the shared review modal (?review=)', () => {
    renderBrief(result())
    const links = within(cardItem(TRENDING.title)).getAllByRole('link', { name: /^Open review \d of 2$/ })
    expect(links.map((link) => link.textContent)).toStrictEqual(['Review 1', 'Review 2'])
    expect(links[0]?.getAttribute('href')).toMatch(/[?&]review=f1(&|$)/)
  })

  it('offers only the actions that fit the card', () => {
    renderBrief(result())
    expect(within(cardItem(TRENDING.title)).getByRole('button', { name: 'Draft a PR/FAQ' })).toBeInTheDocument()
    expect(within(cardItem(NOTE.title)).queryByRole('button', { name: 'Draft a PR/FAQ' })).not.toBeInTheDocument()
    expect(within(cardItem(NOTE.title)).queryByRole('button', { name: 'Compare with last month' })).not.toBeInTheDocument()
  })

  it('Investigate prefills a new conversation with the card and its evidence, and marks it acted', async () => {
    const setCardStates = vi.fn()
    renderBrief(result({}, setCardStates))
    await userEvent.click(within(cardItem(TRENDING.title)).getByRole('button', { name: 'Investigate' }))
    const [request] = assistant.openAssistant.mock.lastCall ?? []
    expect(request).toMatchObject({ context: { feedbackIds: ['f1', 'f2'] } })
    expect(String(request?.prompt)).toContain(TRENDING.title)
    expect(setCardStates).toHaveBeenLastCalledWith({ [TRENDING.id]: 'acted' })
  })

  it("a card's own action uses its own prompt", async () => {
    renderBrief(result())
    await userEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }))
    expect(assistant.openAssistant.mock.lastCall?.[0]?.prompt).toBe('Which issues hurt my objective?')
  })

  it('Dismiss stores the state, and a dismissed card stays hidden', async () => {
    const setCardStates = vi.fn()
    const { unmount } = renderBrief(result({}, setCardStates))
    await userEvent.click(screen.getByRole('button', { name: `Dismiss: ${NOTE.title}` }))
    expect(setCardStates).toHaveBeenLastCalledWith({ [NOTE.id]: 'dismissed' })
    unmount()
    renderBrief(result({ card_state: { [NOTE.id]: 'dismissed' } }))
    expect(screen.queryByRole('heading', { name: NOTE.title })).toBeNull()
  })

  it('offers Undo after a dismissal, which puts the card back in its previous state', async () => {
    const setCardStates = vi.fn()
    renderBrief(result({ card_state: { [NOTE.id]: 'acted', [TRENDING.id]: 'seen', [TODO.id]: 'seen' } }, setCardStates))
    await userEvent.click(screen.getByRole('button', { name: `Dismiss: ${NOTE.title}` }))
    expect(screen.getByRole('status')).toHaveTextContent(`Dismissed: ${NOTE.title}`)
    await userEvent.click(screen.getByRole('button', { name: `Undo dismissing ${NOTE.title}` }))
    expect(setCardStates).toHaveBeenLastCalledWith({ [NOTE.id]: 'acted' })
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('closes the Undo notice by itself after a while, unless it is hovered', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
      renderBrief(result({ card_state: { [NOTE.id]: 'seen', [TRENDING.id]: 'seen', [TODO.id]: 'seen' } }))
      await user.click(screen.getByRole('button', { name: `Dismiss: ${NOTE.title}` }))
      await user.hover(screen.getByRole('button', { name: `Undo dismissing ${NOTE.title}` }))
      await act(() => vi.advanceTimersByTimeAsync(UNDO_TIMEOUT_MS + 1000))
      expect(screen.getByRole('status')).toHaveTextContent('Dismissed')
      await user.unhover(screen.getByRole('button', { name: `Undo dismissing ${NOTE.title}` }))
      await act(() => vi.advanceTimersByTimeAsync(UNDO_TIMEOUT_MS + 1000))
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the cards nobody has marked yet as seen, once', async () => {
    const setCardStates = vi.fn()
    renderBrief(result({ card_state: { [TRENDING.id]: 'acted' } }, setCardStates))
    await waitFor(() => expect(setCardStates).toHaveBeenCalledWith({ [NOTE.id]: 'seen', [TODO.id]: 'seen' }))
    expect(setCardStates).toHaveBeenCalledTimes(1)
  })
})

describe('Radar cards', () => {
  const RELEASE = card('radar_release_dddddddddddddddd', 'radar_release', {
    facts: { brand: 'Rival', brand_key: 'rival' }, urls: ['https://rival.com/changelog', 'javascript:alert(1)'],
  })

  it('links the cited sources (http(s) only) in a new tab', () => {
    renderBrief(result({ cards: [RELEASE] }))
    const links = within(cardItem(RELEASE.title)).getAllByRole('link', { name: /^rival\.com \(/u })
    expect(links.map((link) => [link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]))
      .toStrictEqual([['https://rival.com/changelog', '_blank', 'noopener noreferrer']])
    expect(within(cardItem(RELEASE.title)).queryByText(/javascript/)).toBeNull()
  })

  it('Open Radar leads to the Radar page with the brand preselected', () => {
    renderBrief(result({ cards: [RELEASE] }))
    const open = within(cardItem(RELEASE.title)).getByRole('link', { name: 'Open Radar' })
    expect(open.getAttribute('href')).toBe('/radar?brand=rival')
  })

  it('other cards have no Open Radar and no sources', () => {
    renderBrief(result())
    expect(within(cardItem(TRENDING.title)).queryByRole('link', { name: 'Open Radar' })).toBeNull()
    expect(within(cardItem(TRENDING.title)).queryByText('Sources')).toBeNull()
  })
})

describe('things to do', () => {
  it('lists the to-do cards apart, each linking to where it is done', () => {
    renderBrief(result())
    const section = screen.getByRole('region', { name: 'Things to do' })
    expect(within(section).getByText(TODO.title)).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/connect')
    expect(screen.queryAllByRole('heading', { name: TODO.title })).toStrictEqual([])
  })

  it('says when nothing is waiting', () => {
    renderBrief(result({ cards: [TRENDING] }))
    expect(screen.getByText('Nothing is waiting for you.')).toBeInTheDocument()
  })
})

describe('metric tiles', () => {
  it("read the shared ['summary', {days}] entries Layout and the Dashboard use, not a private key", async () => {
    const client = createTestQueryClient()
    renderWithQueryClient(<TestRouter><MetricTiles /></TestRouter>, client)
    await screen.findByText('12')
    expect(client.getQueryData(['summary', { days: 7 }])).toMatchObject({ total_feedback: 12 })
    expect(client.getQueryData(['summary', { days: 14 }])).toMatchObject({ total_feedback: 12 })
  })

  it('groups the counts the way the Dashboard does ("26,622", not "26622")', async () => {
    summary.current = { period_days: 7, total_feedback: 26_622, avg_sentiment: -0.4, urgent_count: 14_042 }
    renderWithQueryClient(<TestRouter><MetricTiles /></TestRouter>, createTestQueryClient())
    expect(await screen.findAllByText('26,622')).not.toHaveLength(0)
    expect(screen.getAllByText('14,042')).not.toHaveLength(0)
    expect(screen.queryByText('26622')).not.toBeInTheDocument()
  })

  it('writes the sentiment average with the decimal mark of the app language (pl "+0,10")', async () => {
    await i18n.changeLanguage('pl')
    try {
      renderWithQueryClient(<TestRouter><MetricTiles /></TestRouter>, createTestQueryClient())
      expect(await screen.findByText('+0,10')).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})

describe('Refresh', () => {
  it('is disabled and says so while the brief is generating', () => {
    renderWithQueryClient(<RefreshButton generating outcome="started" onRefresh={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Generating...' })).toBeDisabled()
  })

  it('reports an up-to-date brief', () => {
    renderWithQueryClient(<RefreshButton generating={false} outcome="up_to_date" onRefresh={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Your brief is up to date.')
  })

  it('calls onRefresh', async () => {
    const onRefresh = vi.fn()
    renderWithQueryClient(<RefreshButton generating={false} outcome="idle" onRefresh={onRefresh} />)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith()
  })
})
