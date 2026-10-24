/**
 * @fileoverview One value of a dimension: name (stored on reviews), label, and
 * — for a child dimension — which parent value it belongs under.
 *
 * @module components/DimensionsManager/DimensionValueRow
 */
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import type { DraftDimension, DraftValue } from './dimensionDraft'

interface DimensionValueRowProps {
  value: DraftValue
  parent: DraftDimension | undefined
  onChange: (value: DraftValue) => void
  onRemove: () => void
}

export default function DimensionValueRow({ value, parent, onChange, onRemove }: Readonly<DimensionValueRowProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager' })
  const name = value.name === '' ? t('newValue') : value.name
  return (
    <li className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] items-center">
      <input
        type="text"
        value={value.name}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
        aria-label={t('valueNameLabel', { name })}
        placeholder={t('valueNamePlaceholder')}
        className="input font-mono text-sm"
      />
      <input
        type="text"
        value={value.label ?? ''}
        onChange={(e) => onChange({ ...value, label: e.target.value })}
        aria-label={t('valueLabelLabel', { name })}
        placeholder={t('valueLabelPlaceholder')}
        className="input text-sm"
      />
      {parent === undefined ? <span aria-hidden="true" /> : (
        <select
          value={value.parent_value ?? ''}
          onChange={(e) => onChange({ ...value, parent_value: e.target.value === '' ? undefined : e.target.value })}
          aria-label={t('valueParentLabel', { name, parent: parent.label || parent.key })}
          className="select text-sm"
        >
          <option value="">{t('anyParentValue')}</option>
          {parent.values.filter((v) => v.name.trim() !== '').map((v) => (
            <option key={v.uid} value={v.name.trim()}>{v.label === undefined || v.label === '' ? v.name : v.label}</option>
          ))}
        </select>
      )}
      <button type="button" onClick={onRemove} className="icon-btn justify-self-end" aria-label={t('removeValue', { name })} title={t('removeValue', { name })}>
        <Trash2 size={16} />
      </button>
    </li>
  )
}
