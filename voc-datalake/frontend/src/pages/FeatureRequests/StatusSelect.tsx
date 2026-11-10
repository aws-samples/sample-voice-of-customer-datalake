/**
 * @fileoverview A select over the current board's statuses (the admin's status control and the
 * list's status filter), each shown in its words (boardStatuses.ts).
 *
 * @module pages/FeatureRequests/StatusSelect
 */
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { useCurrentBoard } from './boardContext'
import { statusLabel } from './boardStatuses'

/** `allLabel` adds a first "all statuses" choice, whose value is `all`. */
export default function StatusSelect({ label, value, allLabel, disabled = false, onChange }: Readonly<{
  label: string
  value: string
  allLabel?: string
  disabled?: boolean
  onChange: (status: string) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const board = useCurrentBoard()
  return (
    <LabeledField label={label}>
      {(id) => (
        <select id={id} className="select w-auto" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {allLabel === undefined ? null : <option value="all">{allLabel}</option>}
          {board.statuses.map((status) => <option key={status.key} value={status.key}>{statusLabel(status, t)}</option>)}
        </select>
      )}
    </LabeledField>
  )
}
