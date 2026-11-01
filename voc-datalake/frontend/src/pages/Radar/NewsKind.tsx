/**
 * @fileoverview What a Radar news item is (docs/radar.md → "News and releases"): its kind badge
 * (Release, Announcement, Promotion, Partnership, Company news), the muted "via Exa" / "via feed"
 * marker of an item our web search did not find itself, and the kind filter above a news list.
 * Shared by the brand view's timeline, the All brands feed and the Brands table.
 * @module pages/Radar/NewsKind
 */
import { Handshake, Megaphone, Newspaper, Rocket, Tag } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import PressedChoices from '../../components/PressedChoices/PressedChoices'
import { RADAR_NEWS_KINDS } from '../../api/radarNewsFields'
import type { LucideIcon } from 'lucide-react'
import { useNewsKindLabel } from './newsKindLabel'
import type { RadarFoundVia, RadarNewsKind } from '../../api/radarNewsFields'

/** The filter's choice: every kind, or one. */
export type NewsKindChoice = RadarNewsKind | 'all'

const KIND_ICONS: Record<RadarNewsKind, LucideIcon> = {
  release: Rocket, announcement: Megaphone, promotion: Tag, partnership: Handshake, news: Newspaper,
}

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const VIA: Record<Exclude<RadarFoundVia, 'web'>, { labelKey: string }> = {
  exa: { labelKey: 'radar:releases.viaExa' },
  feed: { labelKey: 'radar:releases.viaFeed' },
}

export function NewsKindBadge({ kind }: Readonly<{ kind: RadarNewsKind }>) {
  const label = useNewsKindLabel()
  const Icon = KIND_ICONS[kind]
  return (
    <span className="badge badge-info" data-testid="news-kind">
      <Icon size={12} aria-hidden="true" />{label(kind)}
    </span>
  )
}

/** The kind as a small icon (its name is the tooltip and the accessible text): compact release rows. */
export function NewsKindIcon({ kind }: Readonly<{ kind: RadarNewsKind }>) {
  const label = useNewsKindLabel()
  const Icon = KIND_ICONS[kind]
  return (
    <span className="inline-flex text-muted shrink-0" title={label(kind)} data-testid="news-kind">
      <Icon size={14} aria-hidden="true" /><span className="sr-only">{label(kind)}</span>
    </span>
  )
}

/** "via Exa" / "via feed", only when our own web search is not among the item's sources. */
export function FoundViaMarker({ foundVia }: Readonly<{ foundVia: readonly RadarFoundVia[] }>) {
  const { t } = useTranslation('radar')
  if (foundVia.includes('web')) return null
  const others = foundVia.flatMap((via) => (via === 'web' ? [] : [t(VIA[via].labelKey)]))
  return <span className="text-xs text-muted italic" data-testid="found-via">{others.join(' · ')}</span>
}

const CHOICES: readonly NewsKindChoice[] = ['all', ...RADAR_NEWS_KINDS]

/** All, then one chip per kind; the list below is filtered on the client. */
export function NewsKindFilter({ value, onChange }: Readonly<{ value: NewsKindChoice; onChange: (choice: NewsKindChoice) => void }>) {
  const { t } = useTranslation('radar')
  const label = useNewsKindLabel()
  return (
    <PressedChoices label={t('releases.filterLabel')} choices={CHOICES} value={value} onChange={onChange}
      display={(choice) => (choice === 'all' ? t('releases.kindAll') : label(choice))}
      className="flex flex-wrap gap-1.5 mb-3" pressedClassName="badge badge-accent" idleClassName="badge badge-muted hover:text-text" />
  )
}
