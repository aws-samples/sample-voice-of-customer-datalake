/**
 * @fileoverview What the message will mention, as removable chips under the text, plus the
 * note when `@all` has more personas than one message asks (the server asks the first ones, in
 * project order, the same order as here), and a note for a large library item (about N tokens of input).
 *
 * @module assistant/mentions/MentionChips
 */
import { useTranslation } from 'react-i18next'
import { MENTION_LIMITS } from '@stream/assistant/contract'
import MentionIcon from './MentionIcon'
import RemovableChips from '../components/RemovableChips'
import { LARGE_ITEM_TOKENS, approximateTokens } from './mentionModel'
import type { MentionPick } from './mentionModel'

export default function MentionChips({ picks, personaNames, onRemove }: Readonly<{
  picks: readonly MentionPick[]
  /** The project's persona names, in project order. */
  personaNames: readonly string[]
  onRemove: (key: string) => void
}>) {
  const { t } = useTranslation('assistant')
  if (picks.length === 0) return null
  const capped = picks.some((pick) => pick.kind === 'all') && personaNames.length > MENTION_LIMITS.maxPersonas
  const large = picks.flatMap((pick) => (pick.kind === 'library' && approximateTokens(pick.chars) > LARGE_ITEM_TOKENS
    ? [{ name: pick.token, tokens: approximateTokens(pick.chars) }] : []))
  return (
    <div className="mb-1">
      <RemovableChips
        tone="accent" label={t('mentions.chips')} onRemove={onRemove}
        items={picks.map((pick) => ({
          key: pick.key, icon: <MentionIcon kind={pick.kind} size={12} />, label: pick.token, tooltip: pick.label,
          removeLabel: t('mentions.remove', { name: pick.token }),
        }))}
      />
      {large.map((item) => (
        <p key={item.name} className="mt-0.5 px-1 text-[12px] text-muted">
          {t('mentions.largeItem', { name: item.name, tokens: item.tokens })}
        </p>
      ))}
      {capped && (
        <p className="mt-0.5 px-1 text-[12px] text-muted">
          {t('mentions.allCapped', {
            max: MENTION_LIMITS.maxPersonas,
            total: personaNames.length,
            names: personaNames.slice(0, MENTION_LIMITS.maxPersonas).join(', '),
          })}
        </p>
      )}
    </div>
  )
}
