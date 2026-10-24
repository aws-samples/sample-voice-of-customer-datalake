/**
 * @fileoverview One variant of a design-system component: its name, its style
 * form and the live preview beside it. Read-only shows the preview and the
 * values it was painted from.
 *
 * @module pages/Company/ComponentVariantEditor
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import clsx from 'clsx'
import { COMPONENT_LIMITS, STYLE_KEYS } from '../../api/designComponents'
import type { ComponentVariant, DesignComponent } from '../../api/designComponents'
import type { NamedValue } from '../../api/designSystemApi'
import ComponentStyleForm from './ComponentStyleForm'
import { VariantPreview } from './ComponentPreview'

interface VariantProps {
  readonly component: DesignComponent
  readonly variant: ComponentVariant
  readonly colors: readonly NamedValue[]
  /** The variant's name is used twice in this component. */
  readonly duplicate: boolean
}

export function VariantEditor({ component, variant, colors, duplicate, canRemove, onChange, onRemove }: VariantProps & {
  readonly canRemove: boolean
  readonly onChange: (change: (variant: ComponentVariant) => ComponentVariant) => void
  readonly onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const id = useId()
  const name = variant.name.trim()
  const nameError = name === '' ? t('designSystem.components.variantNameRequired') : null
  const removeLabel = t('designSystem.components.removeVariant', { name: name || t('designSystem.components.untitled') })
  const error = nameError ?? (duplicate ? t('designSystem.components.variantNameTaken') : null)
  return (
    <li className="rounded-md border border-border p-3 space-y-3" data-testid="variant-editor">
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <label htmlFor={id} className="block text-xs text-muted mb-0.5">{t('designSystem.components.variantName')}</label>
          <input
            id={id}
            value={variant.name}
            maxLength={COMPONENT_LIMITS.variantName}
            placeholder={t('designSystem.components.variantPlaceholder')}
            aria-invalid={error !== null}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => onChange((v) => ({ ...v, name: e.target.value }))}
            className={clsx('input w-full', error && 'border-danger')}
          />
        </div>
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="icon-btn"
            aria-label={removeLabel}
            title={removeLabel}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
      {error ? <p id={`${id}-error`} className="text-xs text-danger">{error}</p> : null}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <ComponentStyleForm variant={variant} colors={colors} onChange={onChange} />
        <VariantPreview component={component} variant={variant} colors={colors} />
      </div>
    </li>
  )
}

/** "background=var:primary · radius=8px" — what the variant sets, for read-only viewers. */
function styleSummary(variant: ComponentVariant): string {
  const set = STYLE_KEYS.flatMap((key) => (variant.styles[key] ? [`${key}=${variant.styles[key]}`] : []))
  return set.join(' · ')
}

export function VariantView({ component, variant, colors }: Omit<VariantProps, 'duplicate'>) {
  const { t } = useTranslation('settings')
  const summary = styleSummary(variant)
  return (
    <li className="space-y-2" data-testid="variant-view">
      <p className="text-sm font-medium text-text-strong">{variant.name || t('designSystem.components.untitled')}</p>
      <VariantPreview component={component} variant={variant} colors={colors} />
      {summary ? <p className="text-xs font-mono text-muted break-words [overflow-wrap:anywhere]">{summary}</p> : null}
    </li>
  )
}
