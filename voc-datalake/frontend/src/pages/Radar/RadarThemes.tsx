/**
 * @fileoverview What their customers love and hate (GET /radar/brands/{brand}/page `detail`): the
 * themes grouped by top-level category, one heading per category with its total, the subcategory
 * themes under it with their counts and at most two quotes each (a category whose only theme has no
 * subcategory shows its quotes under the heading), no quote twice in a column
 * (radarGroups). Every count and quote opens the reviews behind it (ReviewsModal, via `onRead`).
 * @module pages/Radar/RadarThemes
 */
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { groupThemes } from './radarGroups'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { ShownTheme, ThemeGroup } from './radarGroups'
import type { RadarReviewFilter } from '../../api/radarApi'
import type { RadarDetail, RadarTheme } from '../../api/radarSchema'

type OnRead = (filter: RadarReviewFilter) => void
/** Love = positive themes, hate = negative ones. */
type Polarity = 'positive' | 'negative'

/** A theme's reviews: its category, its subcategory ('' = none) and the column's sentiment. */
function themeFilter(theme: RadarTheme, sentiment: Polarity): RadarReviewFilter {
  return { category: theme.category, subcategory: theme.subcategory ?? '', sentiment }
}

const COUNT_LINK = 'link text-xs shrink-0 rounded-sm'

/** "4 reviews", named for what it opens (`label`: "Read the 4 reviews of Delivery / Speed"). */
function CountLink({ count, label, onClick }: Readonly<{ count: number; label: string; onClick: () => void }>) {
  const { t } = useTranslation('radar')
  return (
    <button type="button" className={COUNT_LINK} onClick={onClick} aria-label={label}>
      {t('themes.count', { count })}
    </button>
  )
}

/** A theme's quotes; each opens the theme's reviews. */
function Quotes({ quotes, theme, onOpen }: Readonly<{ quotes: readonly string[]; theme: string; onOpen: () => void }>) {
  const { t } = useTranslation('radar')
  return quotes.map((quote) => (
    <button key={quote} type="button" onClick={onOpen}
      className="block w-full text-left text-sm text-text mt-1 border-l-2 border-border pl-2 break-words hover:text-accent-text">
      {quote}<span className="sr-only"> {t('reviews.openTheme', { theme })}</span>
    </button>
  ))
}

function Theme({ shown, sentiment, onRead }: Readonly<{ shown: ShownTheme; sentiment: Polarity; onRead: OnRead }>) {
  const { t } = useTranslation('radar')
  const labels = useDisplayLabels()
  const { theme, quotes } = shown
  const open = () => onRead(themeFilter(theme, sentiment))
  const name = theme.subcategory === null ? t('themes.general') : labels.subcategory(theme.subcategory, theme.category)
  const full = labels.theme(theme.category, theme.subcategory)
  return (
    <li className="min-w-0" data-testid="radar-theme">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm text-text min-w-0 break-words">{name}</span>
        <CountLink count={theme.count} label={t('themes.countLabel', { count: theme.count, theme: full })} onClick={open} />
      </div>
      <Quotes quotes={quotes} theme={full} onOpen={open} />
    </li>
  )
}

/** The group's only theme when it has no subcategory: its quotes go straight under the heading. */
const soleGeneral = (group: ThemeGroup): ShownTheme | undefined =>
  (group.themes.length === 1 && group.themes[0]?.theme.subcategory === null ? group.themes[0] : undefined)

function Group({ group, sentiment, onRead }: Readonly<{ group: ThemeGroup; sentiment: Polarity; onRead: OnRead }>) {
  const { t } = useTranslation('radar')
  const labels = useDisplayLabels()
  const category = labels.category(group.category)
  const sole = soleGeneral(group)
  if (sole !== undefined) return <SoleGroup sole={sole} category={category} sentiment={sentiment} onRead={onRead} />
  return (
    <li className="border-t border-border pt-2 min-w-0" data-testid="radar-theme-group">
      <GroupHeading category={category}>
        <CountLink count={group.total} label={t('themes.groupLabel', { count: group.total, category })}
          onClick={() => onRead({ category: group.category, sentiment })} />
      </GroupHeading>
      <ul className="mt-1 space-y-2 pl-3">
        {group.themes.map((shown) => (
          <Theme key={shown.theme.subcategory ?? ''} shown={shown} sentiment={sentiment} onRead={onRead} />
        ))}
      </ul>
    </li>
  )
}

function GroupHeading({ category, children }: Readonly<{ category: string; children: ReactNode }>) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
      <h4 className="text-sm font-semibold text-text-strong min-w-0 break-words">{category}</h4>
      {children}
    </div>
  )
}

/** A category with one theme and no subcategory: no "General" row repeating its count. */
function SoleGroup({ sole, category, sentiment, onRead }: Readonly<{
  sole: ShownTheme; category: string; sentiment: Polarity; onRead: OnRead
}>) {
  const { t } = useTranslation('radar')
  const open = () => onRead(themeFilter(sole.theme, sentiment))
  return (
    <li className="border-t border-border pt-2 min-w-0" data-testid="radar-theme-group">
      <GroupHeading category={category}>
        <CountLink count={sole.theme.count} label={t('themes.countLabel', { count: sole.theme.count, theme: category })} onClick={open} />
      </GroupHeading>
      <Quotes quotes={sole.quotes} theme={category} onOpen={open} />
    </li>
  )
}

function ThemeColumn({ title, icon: Icon, sentiment, themes, onRead }: Readonly<{
  title: string; icon: LucideIcon; sentiment: Polarity; themes: readonly RadarTheme[]; onRead: OnRead
}>) {
  const { t } = useTranslation('radar')
  const groups = groupThemes(themes)
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-text-strong flex items-center gap-2 mb-2">
        <Icon size={14} className={sentiment === 'positive' ? 'text-ok' : 'text-danger'} aria-hidden="true" />{title}
      </h3>
      {groups.length === 0 ? <p className="text-sm text-muted">{t('themes.empty')}</p> : (
        <ul className="space-y-3">
          {groups.map((group) => <Group key={group.category} group={group} sentiment={sentiment} onRead={onRead} />)}
        </ul>
      )}
    </div>
  )
}

export default function RadarThemes({ detail, onRead }: Readonly<{ detail: RadarDetail; onRead: OnRead }>) {
  const { t } = useTranslation('radar')
  return (
    <section className="card grid gap-6 md:grid-cols-2 min-w-0" aria-label={`${t('themes.love')} / ${t('themes.hate')}`}>
      <ThemeColumn title={t('themes.love')} icon={ThumbsUp} sentiment="positive" themes={detail.love} onRead={onRead} />
      <ThemeColumn title={t('themes.hate')} icon={ThumbsDown} sentiment="negative" themes={detail.hate} onRead={onRead} />
      {detail.sampled ? <p className="text-xs text-text md:col-span-2">{t('themes.sampled')}</p> : null}
    </section>
  )
}
