/**
 * @fileoverview One brief card: what it is (Spike, Urgent, What's new, Trending, Competitor…,
 * tinted by severity), words, quotes, the reviews behind it, and only the buttons that fit it.
 * An act button opens the assistant on a NEW conversation with the prompt
 * prefilled (never sent); Dismiss hides the card for the rest of the day.
 * @module pages/Home/brief/BriefCardItem
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AlertTriangle, ExternalLink, Eye, Info, MessageSquarePlus, Radar, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cardLinks, cardQuotes, cardType, presetsFor, radarBrandKey, radarPath } from './briefCards'
import type { BriefCard, BriefSeverity } from '../../../api/briefingApi'
import type { CardLink, PresetAction } from './briefCards'
import EvidenceLinks from './EvidenceLinks'

const SEVERITY: Record<BriefSeverity, { badge: string; icon: LucideIcon }> = {
  info: { badge: 'badge badge-info', icon: Info },
  warn: { badge: 'badge badge-warn', icon: Eye },
  alert: { badge: 'badge badge-danger', icon: AlertTriangle },
}

const PROMPT_KEYS: Record<PresetAction, 'actions.investigatePrompt' | 'actions.prfaqPrompt' | 'actions.comparePrompt'> = {
  investigate: 'actions.investigatePrompt',
  prfaq: 'actions.prfaqPrompt',
  compare: 'actions.comparePrompt',
}

export interface CardHandlers {
  onAct: (card: BriefCard, prompt: string) => void
  onDismiss: (card: BriefCard) => void
}

/** Hide a card for the rest of the day (its state becomes `dismissed`). */
export function DismissButton({ card, onDismiss }: Readonly<{ card: BriefCard; onDismiss: CardHandlers['onDismiss'] }>) {
  const { t } = useTranslation('briefing')
  return (
    <button type="button" className="btn btn-ghost btn-sm" aria-label={`${t('cards.dismiss')}: ${card.title}`}
      onClick={() => { onDismiss(card) }}>
      <X size={14} aria-hidden="true" />
    </button>
  )
}

function Quotes({ card }: Readonly<{ card: BriefCard }>) {
  const { t } = useTranslation('briefing')
  const quotes = cardQuotes(card)
  if (quotes.length === 0) return null
  return (
    <figure className="space-y-1">
      <figcaption className="text-xs font-medium text-muted">{t('cards.quotes')}</figcaption>
      {quotes.map((quote) => (
        <blockquote key={quote.feedback_id} className="border-l-2 border-border pl-3 text-sm italic text-text">
          {quote.text}
        </blockquote>
      ))}
    </figure>
  )
}

/** The card's cited sources (Radar releases): http(s) links only, opened in a new tab. */
function Sources({ links }: Readonly<{ links: readonly CardLink[] }>) {
  const { t } = useTranslation('briefing')
  if (links.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted">{t('cards.sources')}</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noopener noreferrer"
              className="link inline-flex items-center gap-1 text-sm">
              <ExternalLink size={12} aria-hidden="true" />
              {link.host}
              <span className="sr-only">{` (${t('cards.newTab')})`}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "Open Radar" on a Radar card: the Radar page with the card's brand preselected. */
function OpenRadar({ card }: Readonly<{ card: BriefCard }>) {
  const { t } = useTranslation('briefing')
  const brand = radarBrandKey(card)
  if (brand === undefined) return null
  return (
    <Link to={radarPath(brand)} className="btn btn-secondary btn-sm">
      <Radar size={14} aria-hidden="true" />
      {t('actions.openRadar')}
    </Link>
  )
}

function Actions({ card, onAct }: Readonly<{ card: BriefCard; onAct: CardHandlers['onAct'] }>) {
  const { t } = useTranslation('briefing')
  const words = { title: card.title, body: card.body }
  return (
    <div className="flex flex-wrap gap-2">
      {card.actions.map((action) => (
        <button key={action.label} type="button" className="btn btn-primary btn-sm" onClick={() => { onAct(card, action.prompt) }}>
          <MessageSquarePlus size={14} aria-hidden="true" />
          {action.label}
        </button>
      ))}
      {presetsFor(card.kind).map((preset) => (
        <button key={preset} type="button" className="btn btn-secondary btn-sm"
          onClick={() => { onAct(card, t(PROMPT_KEYS[preset], words)) }}>
          {t(`actions.${preset}`)}
        </button>
      ))}
      <OpenRadar card={card} />
    </div>
  )
}

export default function BriefCardItem({ card, onAct, onDismiss }: Readonly<{ card: BriefCard } & CardHandlers>) {
  const { t } = useTranslation('briefing')
  const severity = SEVERITY[card.severity]
  const Icon = severity.icon
  return (
    <li className="card space-y-3" data-card-kind={card.kind}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <span className={severity.badge}>
            <Icon size={12} aria-hidden="true" />
            {t(`cards.type.${cardType(card.kind)}`)}
          </span>
          <h3 className="font-semibold text-text-strong">{card.title}</h3>
          {card.body !== '' && <p className="text-sm text-text">{card.body}</p>}
        </div>
        <DismissButton card={card} onDismiss={onDismiss} />
      </div>
      <Quotes card={card} />
      <Sources links={cardLinks(card)} />
      <EvidenceLinks feedbackIds={card.feedback_ids} brand={radarBrandKey(card)} />
      <Actions card={card} onAct={onAct} />
    </li>
  )
}
