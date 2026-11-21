/**
 * @fileoverview One column of the file in the wizard's Map step: its header, a few of its values, the kind the server
 * detected with its confidence and its reasons in the reader's language, and a select to choose another. A column of
 * personal data (an email, a name) carries a warning: it is dropped unless a person picks another kind.
 *
 * @module pages/Scrapers/ImportWizard/ColumnCard
 */
import { ShieldAlert } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { COLUMN_KINDS, PERSONAL_KINDS } from '../../../api/importWizardSchema'
import type { ColumnKind, DetectedColumn } from '../../../api/importWizardSchema'
import { kindLabel, reasonsText } from './columnText'

const HIGH = 0.8
const MEDIUM = 0.5
const SHOWN_VALUES = 4

type Certainty = 'high' | 'medium' | 'low'

function certaintyOf(confidence: number): Certainty {
  if (confidence >= HIGH) return 'high'
  return confidence >= MEDIUM ? 'medium' : 'low'
}

const CERTAINTY_BADGES: Readonly<Record<Certainty, string>> = {
  high: 'badge badge-success', medium: 'badge badge-muted', low: 'badge badge-warn',
}

export default function ColumnCard({ column, kind, onKind }: Readonly<{
  column: DetectedColumn
  kind: ColumnKind
  onKind: (kind: ColumnKind) => void
}>) {
  const { t } = useTranslation('scrapers')
  const selectId = useId()
  const certainty = certaintyOf(kind === column.kind ? column.confidence : 1)
  const values = column.values.slice(0, SHOWN_VALUES)
  return (
    <li className="rounded-md border border-border p-3 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-strong break-words min-w-0">{column.header}</h3>
        <span className={CERTAINTY_BADGES[certainty]}>{t(`importWizard.map.confidence.${certainty}`)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-xs text-muted">{t('importWizard.map.kind')}</label>
        <select id={selectId} className="select w-auto text-sm" value={kind}
          onChange={(event) => onKind(COLUMN_KINDS.find((option) => option === event.target.value) ?? 'ignore')}>
          {COLUMN_KINDS.map((option) => <option key={option} value={option}>{kindLabel(t, option)}</option>)}
        </select>
      </div>
      <p className="text-xs text-text">{kind === column.kind ? reasonsText(t, column) : t('importWizard.reasons.chosen')}</p>
      {values.length > 0 && !PERSONAL_KINDS.has(column.kind) && (
        <p className="text-xs text-muted break-words">{t('importWizard.map.examples', { values: values.join(' · ') })}</p>
      )}
      {PERSONAL_KINDS.has(kind) && (
        <p className="text-xs text-warn inline-flex items-center gap-1"><ShieldAlert size={12} aria-hidden="true" />{t('importWizard.map.personal')}</p>
      )}
    </li>
  )
}
