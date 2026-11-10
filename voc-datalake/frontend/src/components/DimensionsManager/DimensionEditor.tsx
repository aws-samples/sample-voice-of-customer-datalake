/**
 * @fileoverview One dimension in the editor: key, label, description, whether
 * the model may infer it, an optional parent, and its values.
 *
 * @module components/DimensionsManager/DimensionEditor
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { RemoveRowButton } from '../DraftSaveBar/DraftParts'
import SwitchField from '../SwitchField/SwitchField'
import DimensionValueRow from './DimensionValueRow'
import { childrenOf, newValue, parentOptions } from './dimensionDraft'
import type { DraftDimension } from './dimensionDraft'

interface DimensionEditorProps {
  dimension: DraftDimension
  draft: readonly DraftDimension[]
  onChange: (dimension: DraftDimension) => void
  onRemove: () => void
}

function TextField({ label, value, onChange, mono = false, placeholder }: Readonly<{
  label: string; value: string; onChange: (value: string) => void; mono?: boolean; placeholder?: string
}>) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{label}</label>
      <input id={id} type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={mono ? 'input font-mono' : 'input'} />
    </div>
  )
}

function ParentField({ dimension, draft, onChange }: Readonly<Pick<DimensionEditorProps, 'dimension' | 'draft' | 'onChange'>>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager' })
  const id = useId()
  const options = parentOptions(draft, dimension)
  const children = childrenOf(draft, dimension.key)
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{t('parentLabel')}</label>
      <select
        id={id}
        value={dimension.parent ?? ''}
        disabled={children.length > 0}
        onChange={(e) => onChange({ ...dimension, parent: e.target.value === '' ? undefined : e.target.value })}
        className="select"
      >
        <option value="">{t('noParent')}</option>
        {options.map((d) => <option key={d.uid} value={d.key}>{d.label || d.key}</option>)}
      </select>
      <p className="text-xs text-muted mt-1">
        {children.length > 0 ? t('parentOfChildren', { children: children.join(', ') }) : t('parentHint')}
      </p>
    </div>
  )
}

export default function DimensionEditor({ dimension, draft, onChange, onRemove }: Readonly<DimensionEditorProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager' })
  const [valueName, setValueName] = useState('')
  const parent = draft.find((d) => d.key === dimension.parent && d.uid !== dimension.uid)
  const title = dimension.label || dimension.key || t('newDimension')

  const addValue = () => {
    const name = valueName.trim()
    if (name === '') return
    onChange({ ...dimension, values: [...dimension.values, newValue(name)] })
    setValueName('')
  }

  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold tracking-tight text-text-strong">{title}</h4>
        <RemoveRowButton label={t('removeDimension', { name: title })} onRemove={onRemove} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label={t('keyLabel')} value={dimension.key} mono placeholder="product" onChange={(key) => onChange({ ...dimension, key })} />
        <TextField label={t('labelLabel')} value={dimension.label} placeholder={t('labelPlaceholder')} onChange={(label) => onChange({ ...dimension, label })} />
        <TextField label={t('descriptionLabel')} value={dimension.description ?? ''} onChange={(description) => onChange({ ...dimension, description })} />
        <ParentField dimension={dimension} draft={draft} onChange={onChange} />
      </div>
      <SwitchField checked={dimension.infer} onChange={(infer) => onChange({ ...dimension, infer })} label={t('inferLabel')} hint={t('inferHint')} />
      <div>
        <p className="text-xs font-medium text-text mb-2">{t('valuesTitle', { n: dimension.values.length })}</p>
        <ul className="space-y-2">
          {dimension.values.map((value) => (
            <DimensionValueRow
              key={value.uid}
              value={value}
              parent={parent}
              onChange={(next) => onChange({ ...dimension, values: dimension.values.map((v) => (v.uid === value.uid ? next : v)) })}
              onRemove={() => onChange({ ...dimension, values: dimension.values.filter((v) => v.uid !== value.uid) })}
            />
          ))}
        </ul>
        <div className="flex flex-col sm:flex-row gap-2 mt-2">
          <input
            type="text"
            value={valueName}
            onChange={(e) => setValueName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addValue() }}
            placeholder={t('valueNamePlaceholder')}
            aria-label={t('addValueLabel', { name: title })}
            className="input font-mono flex-1"
          />
          <button type="button" onClick={addValue} disabled={valueName.trim() === ''} className="btn btn-secondary">
            <Plus size={14} aria-hidden="true" /> {t('addValue')}
          </button>
        </div>
      </div>
    </section>
  )
}
