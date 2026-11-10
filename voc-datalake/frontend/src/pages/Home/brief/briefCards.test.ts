/**
 * @fileoverview Pure helpers of the brief on Home: greeting, card filters, quotes,
 * tiles arithmetic, and keeping the cards on screen while a new brief builds.
 */
import { describe, it, expect } from 'vitest'
import { NO_BRIEF } from '../../../api/briefingApi'
import { cardLinks, cardQuotes, cardType, displayName, greetingKey, isTodo, percentChange, presetsFor, radarBrandKey, radarPath, tiles,
  unseenIds, visibleCards } from './briefCards'
import { keepCards } from './useBrief'
import type { BriefCard } from '../../../api/briefingApi'

function card(id: string, kind = 'trending_topic', facts: Record<string, unknown> = {}): BriefCard {
  return { id, kind, layer: 'org', severity: 'info', title: id, body: '', facts, actions: [], feedback_ids: [], urls: [] }
}

describe('greeting', () => {
  it.each([[5, 'greeting.morning'], [11, 'greeting.morning'], [12, 'greeting.afternoon'], [17, 'greeting.afternoon'],
    [18, 'greeting.evening'], [2, 'greeting.evening']])('hour %i is %s', (hour, key) => {
    expect(greetingKey(hour)).toBe(key)
  })

  it('falls back from the name to the email', () => {
    expect([displayName({ name: 'Ana', email: 'user@example.com' }), displayName({ name: ' ', email: 'user@example.com' }),
      displayName(null)]).toStrictEqual(['Ana', 'user@example.com', ''])
  })
})

describe('cards', () => {
  const cards = [card('a'), card('b'), card('todo', 'todo_mcp_tokens')]

  it('hides dismissed cards and keeps the rest in order', () => {
    expect(visibleCards(cards, { a: 'dismissed', b: 'acted' }).map((c) => c.id)).toStrictEqual(['b', 'todo'])
  })

  it('lists only the cards with no state yet as unseen', () => {
    expect(unseenIds(cards, { a: 'seen' })).toStrictEqual(['b', 'todo'])
  })

  it('tells a to-do from a brief card', () => {
    expect(cards.map(isTodo)).toStrictEqual([false, false, true])
  })

  it('reads only well-formed quotes from the facts', () => {
    const quoted = card('q', 'trending_topic', { quotes: [{ feedback_id: 'f1', text: 'Late again' }, { text: '' }, 'junk'] })
    expect(cardQuotes(quoted)).toStrictEqual([{ feedback_id: 'f1', text: 'Late again' }])
  })
})

describe('tiles', () => {
  it('compares the last 7 days with the 7 before (14-day answer minus 7-day answer)', () => {
    const numbers = tiles(
      { total_feedback: 30, avg_sentiment: 0.2, urgent_count: 4 },
      { total_feedback: 50, avg_sentiment: 0.3, urgent_count: 6 },
    )
    expect(numbers.reviews).toStrictEqual({ current: 30, change: 50 })
    expect(numbers.urgent).toStrictEqual({ current: 4, change: 100 })
    expect(numbers.sentiment.change).toBe(-25)
  })

  it('has no change to show without a previous window', () => {
    expect(percentChange(5, 0)).toBeUndefined()
  })
})

describe('keepCards', () => {
  const shown = { ...NO_BRIEF, status: 'ready' as const, cards: [card('old')] }

  it('keeps the previous cards while a new day builds', () => {
    const merged = keepCards(shown, { ...NO_BRIEF, status: 'pending', requested_at: 'now' })
    expect([merged.status, merged.cards.map((c) => c.id), merged.requested_at]).toStrictEqual(['pending', ['old'], 'now'])
  })

  it('takes a finished brief as it is', () => {
    const fresh = { ...NO_BRIEF, status: 'ready' as const, cards: [card('new')] }
    expect(keepCards(shown, fresh)).toBe(fresh)
  })
})

describe('radar cards', () => {
  it('keeps only absolute http(s) sources, once each', () => {
    const urls = ['https://www.rival.com/blog', 'javascript:alert(1)', '/radar', 'http://news.example.org/a',
      'https://www.rival.com/blog', 'data:text/html,x']
    expect(cardLinks({ ...card('r', 'radar_release'), urls }).map((link) => [link.href, link.host])).toStrictEqual([
      ['https://www.rival.com/blog', 'rival.com'], ['http://news.example.org/a', 'news.example.org']])
  })

  it('names the brand of a Radar card only', () => {
    expect([radarBrandKey(card('a', 'radar_complaints', { brand_key: 'rival' })),
      radarBrandKey(card('b', 'trending_topic', { brand_key: 'rival' })),
      radarBrandKey(card('c', 'radar_release', { brand_key: '../admin' }))]).toStrictEqual(['rival', undefined, undefined])
  })

  it('links the Radar page with the brand preselected', () => {
    expect(radarPath('rival-co')).toBe('/radar?brand=rival-co')
  })
})

describe('cardType / presetsFor (a clear type label, and only the actions that fit)', () => {
  it.each([
    ['alert_spike', 'spike'], ['alert_urgent', 'urgent'], ['whats_new', 'whatsNew'], ['trending_topic', 'trending'],
    ['radar_release', 'competitor'], ['todo_mcp_tokens', 'nextStep'], ['personal_note', 'update'], ['constructor', 'update'],
  ])('%s is a %s card', (kind, type) => {
    expect(cardType(kind)).toBe(type)
  })

  it('drafts a PR/FAQ only for a problem, and gives a to-do no assistant action', () => {
    expect(presetsFor('alert_spike')).toContain('prfaq')
    expect(presetsFor('radar_beats_us')).toStrictEqual(['investigate'])
    expect(presetsFor('whats_new')).not.toContain('prfaq')
    expect(presetsFor('todo_agent_runs')).toStrictEqual([])
  })
})
