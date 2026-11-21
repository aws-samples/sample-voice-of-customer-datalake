/**
 * @fileoverview The live contrast table of the palette being edited (audit §2.3): the four pairs, each with an icon
 * (✓ / ▲ / ✕), its ratio and the words "AA" or "Below AA" (never colour alone), and under it a note for each pair below
 * its minimum (`role="note"`, the colour fields describe themselves by it) with one-click suggestions that move the
 * colour in OKLCH lightness only ("Use #6f7681 (4.6:1)"). On a live form kept on the theme it already has (`kept`),
 * text under 3:1 is shown as the warning it is there ("This form's text is hard to read"), not as a block.
 *
 * @module pages/FeedbackForms/theme/ContrastTable
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AlertTriangle, CircleCheck, CircleX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import type { ThemePalette } from '../model/formsV2'
import { formatCount, formatDecimal } from '../../../utils/numberFormat'
import { shownRatio } from '../model/validateForm'
import { contrastNoteId, pairSuggestions } from './contrast'
import type { ContrastPair, PairId, PairLevel, PaletteColour } from './contrast'

const ICONS: Readonly<Record<PairLevel, LucideIcon>> = { ok: CircleCheck, warn: AlertTriangle, error: CircleX }
const TONES: Readonly<Record<PairLevel, string>> = { ok: 'text-ok', warn: 'text-warn', error: 'text-danger' }
const NOTE_KEYS: Readonly<Record<Exclude<PairId, 'edge'>, Readonly<Record<'warn' | 'error', string>>>> = {
  text: { warn: 'problems.themeTextLow', error: 'problems.themeUnreadable' },
  primary: { warn: 'problems.themePrimaryLow', error: 'problems.themePrimaryLow' },
  label: { warn: 'problems.themeLabelLow', error: 'problems.themeLabelLow' },
}

/** How a pair reads: its own level, except a kept live theme's unreadable text, which only warns. */
const shownLevel = (pair: ContrastPair, kept: boolean): PairLevel => (kept && pair.level === 'error' ? 'warn' : pair.level)

/** A note's words: a kept live theme's unreadable text warns; elsewhere it says that publishing waits for it. */
function noteText(t: TFunction<'feedbackForms'>, pair: ContrastPair, kept: boolean, ratio: string): string {
  if (pair.id === 'edge' || pair.level === 'ok') return ''
  if (pair.level === 'error' && kept) return t('problems.themeUnreadableLive', { ratio })
  if (pair.level === 'error') return `${t(NOTE_KEYS[pair.id].error, { ratio })} ${t('problems.blocksPublishOnly')}`
  return t(NOTE_KEYS[pair.id].warn, { ratio })
}

function PairNote({ base, pair, palette, kept, onUse }: Readonly<{
  base: string; pair: ContrastPair; palette: ThemePalette; kept: boolean; onUse: (colour: PaletteColour, value: string) => void
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  if (pair.level === 'ok' || pair.id === 'edge' || pair.ratio === null) return null
  const ratio = formatDecimal(shownRatio(pair.ratio, pair.level === 'error' ? 3 : pair.minimum), i18n.language, 1)
  const level = shownLevel(pair, kept)
  const Icon = ICONS[level]
  const fixes = pairSuggestions(pair, palette)
  return (
    <div id={contrastNoteId(base, pair.id)} role="note" className="space-y-1.5 text-[13px] text-text">
      <p className="flex items-start gap-1.5">
        <Icon size={14} aria-hidden="true" className={clsx('mt-0.5 shrink-0', TONES[level])} />
        <span>{noteText(t, pair, kept, ratio)}</span>
      </p>
      {fixes.length > 0 && (
        <div className="flex flex-wrap gap-2 ps-5">
          {fixes.map((fix) => (
            <button key={fix.colour} type="button" className="btn btn-secondary btn-sm" onClick={() => onUse(pair.colour, fix.colour)}>
              {/* The suggested colour itself: customer data, shown as it would be drawn. */}
              <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-control-border" style={{ backgroundColor: fix.colour }} />
              {t('theme.contrast.use', { colour: fix.colour, ratio: formatDecimal(shownRatio(fix.ratio, pair.minimum), i18n.language, 1) })}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ContrastTable({ base, pairs, palette, kept = false, onUse }: Readonly<{
  /** The editor's id, the notes' prefix. */
  base: string
  pairs: readonly ContrastPair[]
  palette: ThemePalette
  /** A live form kept on the theme it already has: its unreadable text warns (the server saves it, with a warning). */
  kept?: boolean
  onUse: (colour: PaletteColour, value: string) => void
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const label: Readonly<Record<PairId, string>> = {
    text: t('theme.contrast.text'), primary: t('theme.contrast.primary'), label: t('theme.contrast.label'), edge: t('theme.contrast.edge'),
  }
  return (
    <div className="space-y-3">
      <table className="w-full text-[13px]">
        <thead className="sr-only">
          <tr><th scope="col">{t('theme.contrast.pair')}</th><th scope="col">{t('theme.contrast.ratio')}</th><th scope="col">{t('theme.contrast.result')}</th></tr>
        </thead>
        <tbody className="divide-y divide-border">
          {pairs.map((pair) => {
            const level = shownLevel(pair, kept)
            const Icon = ICONS[level]
            return (
              <tr key={pair.id}>
                <th scope="row" className="py-1.5 pe-2 text-start font-normal text-text">
                  {label[pair.id]}
                  <span className="ms-1 text-muted">{t('theme.contrast.minimum', { ratio: formatCount(pair.minimum, i18n.language) })}</span>
                </th>
                <td className="py-1.5 pe-2 text-end font-mono tabular-nums text-text-strong">
                  {pair.ratio === null ? '—' : t('theme.contrast.value', { ratio: formatDecimal(shownRatio(pair.ratio, pair.minimum), i18n.language, 1) })}
                </td>
                <td className="whitespace-nowrap py-1.5">
                  <span className="inline-flex items-center gap-1">
                    <Icon size={14} aria-hidden="true" className={TONES[level]} />
                    {pair.level === 'ok' ? t('theme.contrast.aa') : t('theme.contrast.belowAa')}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {pairs.map((pair) => <PairNote key={pair.id} base={base} pair={pair} palette={palette} kept={kept} onUse={onUse} />)}
    </div>
  )
}
