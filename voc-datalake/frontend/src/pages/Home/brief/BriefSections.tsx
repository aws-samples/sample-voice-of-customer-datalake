/**
 * @fileoverview The brief's two lists on Home: the cards, then "Things to do".
 * @module pages/Home/brief/BriefSections
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import BriefCardItem, { DismissButton } from './BriefCardItem'
import { TODO_LINKS } from './briefCards'
import type { BriefCard } from '../../../api/briefingApi'
import type { CardHandlers } from './BriefCardItem'

export function BriefCardList({ cards, onAct, onDismiss }: Readonly<{ cards: BriefCard[] } & CardHandlers>) {
  const { t } = useTranslation('briefing')
  return (
    <section aria-labelledby="brief-cards-title" className="space-y-3">
      <h2 id="brief-cards-title" className="text-lg font-semibold tracking-tight text-text-strong">{t('cards.title')}</h2>
      {cards.length === 0
        ? <p className="text-sm text-muted">{t('cards.empty')}</p>
        : (
          <ul className="space-y-3">
            {cards.map((card) => <BriefCardItem key={card.id} card={card} onAct={onAct} onDismiss={onDismiss} />)}
          </ul>
        )}
    </section>
  )
}

function TodoRow({ card, onDismiss }: Readonly<{ card: BriefCard; onDismiss: CardHandlers['onDismiss'] }>) {
  const { t } = useTranslation('briefing')
  const to = TODO_LINKS[card.kind]
  return (
    <li className="flex items-center justify-between gap-3 py-2" data-card-kind={card.kind}>
      <span className="text-sm text-text min-w-0">
        <span className="badge badge-muted mr-2">{t('cards.type.nextStep')}</span>
        {card.title}
      </span>
      <span className="flex shrink-0 gap-1">
        {to !== undefined && (
          <Link to={to} className="btn btn-secondary btn-sm">
            {t('todo.open')}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
        <DismissButton card={card} onDismiss={onDismiss} />
      </span>
    </li>
  )
}

export function ThingsToDo({ cards, onDismiss }: Readonly<{ cards: BriefCard[]; onDismiss: CardHandlers['onDismiss'] }>) {
  const { t } = useTranslation('briefing')
  return (
    <section aria-labelledby="brief-todo-title" className="card space-y-2">
      <h2 id="brief-todo-title" className="font-semibold text-text-strong">{t('todo.title')}</h2>
      {cards.length === 0
        ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <CheckCircle2 size={14} aria-hidden="true" className="text-ok" />
            {t('todo.empty')}
          </p>
        )
        : (
          <ul className="divide-y divide-border">
            {cards.map((card) => <TodoRow key={card.id} card={card} onDismiss={onDismiss} />)}
          </ul>
        )}
    </section>
  )
}
