/**
 * @fileoverview A request's template field values (`kind`, `severity`, `area`, `steps`, …) as
 * plain text — the board renders no posted HTML or markdown. The one link is the `link` field, and
 * only when it is an `https:` URL (`rel="noopener noreferrer nofollow"`); anything else shows as text.
 *
 * `compact` (a list card) shows the short facts only: choices, the area, the reference.
 *
 * @module pages/FeatureRequests/RequestFieldValues
 */
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { FIELD_SPECS } from '../../api/boardFields'
import { isHttpsUrl } from '../../utils/httpsUrl'
import type { FieldKey } from '../../api/boardFields'
import type { FeatureRequest } from '../../api/featureRequestsApi'
import { useCurrentBoard } from './boardContext'
import { CHOICE_LABELS, FIELD_LABELS } from './boardLabels'
import { templateKeysOf } from './templateDraft'

const COMPACT_KEYS: readonly FieldKey[] = ['kind', 'severity', 'area', 'outcome', 'reference']

function ValueText({ fieldKey, value }: Readonly<{ fieldKey: FieldKey; value: string | number }>) {
  const { t } = useTranslation('featureRequests')
  const text = String(value)
  if (fieldKey === 'link') {
    return isHttpsUrl(text) ? (
      <a className="link inline-flex items-center gap-1 break-all" href={text} target="_blank" rel="noopener noreferrer nofollow">
        {text}<ExternalLink size={12} aria-hidden="true" />
      </a>
    ) : <span className="break-all">{text}</span>
  }
  if (fieldKey === 'rating') return <>{t('totals.rating', { value: text })}</>
  const labelKey = FIELD_SPECS[fieldKey].type === 'choice' ? CHOICE_LABELS[`${fieldKey}.${text}`]?.labelKey : undefined
  return <span className={FIELD_SPECS[fieldKey].type === 'longtext' ? 'whitespace-pre-wrap break-words' : 'break-words'}>
    {labelKey === undefined ? text : t(labelKey)}
  </span>
}

export default function RequestFieldValues({ request, compact = false }: Readonly<{ request: FeatureRequest; compact?: boolean }>) {
  const { t } = useTranslation('featureRequests')
  const board = useCurrentBoard()
  const values = request.fields ?? {}
  const shown = templateKeysOf(board.fields)
    .filter((key) => !compact || COMPACT_KEYS.includes(key))
    .flatMap((key) => {
      const value = values[key]
      return value === undefined || value === '' ? [] : [[key, value] as const]
    })
  if (shown.length === 0) return null
  if (compact) {
    return (
      <p className="flex flex-wrap gap-2 text-xs">
        {shown.map(([key, value]) => (
          <span key={key} className="badge badge-muted">{t(FIELD_LABELS[key].labelKey)}: <ValueText fieldKey={key} value={value} /></span>
        ))}
      </p>
    )
  }
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2 text-sm">
      {shown.map(([key, value]) => (
        <div key={key} className={FIELD_SPECS[key].type === 'longtext' ? 'sm:col-span-2 min-w-0' : 'min-w-0'}>
          <dt className="text-xs text-muted">{t(FIELD_LABELS[key].labelKey)}</dt>
          <dd className="text-text"><ValueText fieldKey={key} value={value} /></dd>
        </div>
      ))}
    </dl>
  )
}
