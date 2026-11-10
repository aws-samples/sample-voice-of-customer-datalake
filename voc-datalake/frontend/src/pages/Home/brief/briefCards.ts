/**
 * @fileoverview Pure helpers for the brief on Home: the greeting, which cards show
 * where, the quotes a card carries, and the prompts of its act buttons.
 * @module pages/Home/brief/briefCards
 */
import { z } from 'zod'
import { parsedList } from '../../../api/schemaList'
import type { BriefCard, CardState } from '../../../api/briefingApi'
import type { MetricsSummary } from '../../../api/types'

export type GreetingKey = 'greeting.morning' | 'greeting.afternoon' | 'greeting.evening'

/** Morning until noon, afternoon until 18:00, evening after (local time). */
export function greetingKey(hour: number): GreetingKey {
  if (hour >= 5 && hour < 12) return 'greeting.morning'
  if (hour >= 12 && hour < 18) return 'greeting.afternoon'
  return 'greeting.evening'
}

export function displayName(user: { name?: string; email: string } | null | undefined): string {
  const name = user?.name?.trim() ?? ''
  return name !== '' ? name : (user?.email ?? '')
}

const TODO_PREFIX = 'todo_'

/** Where a "Things to do" card leads. */
export const TODO_LINKS: Readonly<Record<string, string>> = {
  todo_agent_runs: '/agents',
  todo_memory_review: '/memory',
  todo_mcp_tokens: '/connect',
}

export function isTodo(card: BriefCard): boolean {
  return card.kind.startsWith(TODO_PREFIX)
}

export function visibleCards(cards: readonly BriefCard[], states: Readonly<Record<string, CardState>>): BriefCard[] {
  return cards.filter((card) => states[card.id] !== 'dismissed')
}

/** Card ids nobody has marked yet (marked `seen` once the brief is on screen). */
export function unseenIds(cards: readonly BriefCard[], states: Readonly<Record<string, CardState>>): string[] {
  return cards.filter((card) => states[card.id] === undefined).map((card) => card.id)
}

const QuotesSchema = parsedList(z.object({ feedback_id: z.string(), text: z.string().min(1) }))

/** The PII-redacted quotes a card's facts carry (trending topics). */
export function cardQuotes(card: BriefCard): { feedback_id: string; text: string }[] {
  return QuotesSchema.parse(card.facts.quotes)
}

export type PresetAction = 'investigate' | 'prfaq' | 'compare'
const PRESET_ACTIONS: readonly PresetAction[] = ['investigate', 'prfaq', 'compare']

/** What a card IS, in a word a reader recognises: the label on its badge (instead of "Note"). */
export type CardType = 'spike' | 'urgent' | 'whatsNew' | 'trending' | 'sentiment' | 'competitor' | 'nextStep' | 'update'

const CARD_TYPE_BY_KIND: Readonly<Record<string, CardType>> = {
  alert_spike: 'spike',
  alert_urgent: 'urgent',
  whats_new: 'whatsNew',
  trending_topic: 'trending',
  sentiment_shift: 'sentiment',
}

/** The card's type from its kind (a Radar kind is a competitor, a things-to-do kind a next step); "update" for a kind added later. */
export function cardType(kind: string): CardType {
  if (kind.startsWith(RADAR_KIND_PREFIX)) return 'competitor'
  if (kind.startsWith(TODO_PREFIX)) return 'nextStep'
  return Object.hasOwn(CARD_TYPE_BY_KIND, kind) ? CARD_TYPE_BY_KIND[kind] ?? 'update' : 'update'
}

/**
 * Only the actions that fit the card: a PR/FAQ answers a problem (a spike, urgent
 * reviews, a trend or a sentiment drop), not a release or another brand; "compare with
 * last month" needs our own numbers; a competitor card opens Radar (its own button).
 */
const PRESETS_BY_TYPE: Readonly<Record<CardType, readonly PresetAction[]>> = {
  spike: PRESET_ACTIONS,
  urgent: ['investigate', 'prfaq'],
  trending: PRESET_ACTIONS,
  sentiment: PRESET_ACTIONS,
  whatsNew: ['investigate', 'compare'],
  competitor: ['investigate'],
  nextStep: [],
  update: ['investigate'],
}

export function presetsFor(kind: string): readonly PresetAction[] {
  return PRESETS_BY_TYPE[cardType(kind)]
}

export interface CardLink {
  href: string
  host: string
}

function webLink(raw: string): CardLink | undefined {
  try {
    const url = new URL(raw)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
      ? { href: url.href, host: url.hostname.replace(/^www\./, '') }
      : undefined
  } catch {
    return undefined
  }
}

/** The card's cited sources that may become links: absolute http(s) URLs only, de-duplicated. */
export function cardLinks(card: BriefCard): CardLink[] {
  const links = card.urls.map(webLink).filter((link): link is CardLink => link !== undefined)
  return links.filter((link, index) => links.findIndex((other) => other.href === link.href) === index)
}

const RADAR_KIND_PREFIX = 'radar_'
const BRAND_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_-]{0,63}$/u

/** The Radar brand a Radar card is about (its `brand_key` fact), undefined for any other card. */
export function radarBrandKey(card: BriefCard): string | undefined {
  const key = card.facts.brand_key
  return card.kind.startsWith(RADAR_KIND_PREFIX) && typeof key === 'string' && BRAND_KEY.test(key) ? key : undefined
}

/** The Radar page with the brand preselected. */
export function radarPath(brandKey: string): string {
  return `/radar?${new URLSearchParams({ brand: brandKey }).toString()}`
}

/** The browser's IANA time zone (what a subscription is read in). */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Metric tiles: the previous 7-day window is the 14-day answer minus the 7-day one. */
export interface TileNumbers {
  current: number
  change: number | undefined
}

/** Whole-percent change, undefined when there is nothing to compare with. */
export function percentChange(current: number, previous: number): number | undefined {
  return previous > 0 ? Math.round(((current - previous) * 100) / previous) : undefined
}

type SummaryCounts = Pick<MetricsSummary, 'total_feedback' | 'avg_sentiment' | 'urgent_count'>

export function tiles(week: SummaryCounts, fortnight: SummaryCounts): Record<'reviews' | 'sentiment' | 'urgent', TileNumbers> {
  const previousReviews = Math.max(0, fortnight.total_feedback - week.total_feedback)
  const previousSentimentSum = fortnight.avg_sentiment * fortnight.total_feedback - week.avg_sentiment * week.total_feedback
  const previousSentiment = previousReviews > 0 ? previousSentimentSum / previousReviews : 0
  const previousUrgent = Math.max(0, fortnight.urgent_count - week.urgent_count)
  return {
    reviews: { current: week.total_feedback, change: percentChange(week.total_feedback, previousReviews) },
    sentiment: {
      current: week.avg_sentiment,
      change: previousReviews > 0 ? Math.round((week.avg_sentiment - previousSentiment) * 100) : undefined,
    },
    urgent: { current: week.urgent_count, change: percentChange(week.urgent_count, previousUrgent) },
  }
}
