/**
 * @fileoverview Design system → Components: how the company's buttons, inputs,
 * cards… look. Each component expands to its name, description, variants (≤ 6,
 * each with a style form and a live preview) and, under Advanced, an example
 * HTML snippet shown only in a sandboxed frame. Admins add (≤ 30) and remove
 * (asks first); everyone else sees the previews. Edits go to the section's
 * draft and are stored with its Save.
 *
 * @module pages/Company/DesignComponentsEditor
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { COMPONENT_LIMITS, duplicateNames } from '../../api/designComponents'
import type { ComponentVariant, DesignComponent } from '../../api/designComponents'
import type { NamedValue } from '../../api/designSystemApi'
import { GroupLabel } from './ContextParts'
import { ExampleFrame, MiniPreview } from './ComponentPreview'
import { VariantEditor, VariantView } from './ComponentVariantEditor'
import { emptyComponent, emptyVariant, nextVariantName, removeAt, updateAt } from './componentDraft'

type ListChange = (change: (components: DesignComponent[]) => DesignComponent[]) => void

export default function DesignComponentsEditor({ components, colors, readOnly, onChange }: Readonly<{
  components: DesignComponent[]
  /** The current colour tokens: `var:<name>` values resolve against them. */
  colors: readonly NamedValue[]
  readOnly: boolean
  onChange: ListChange
}>) {
  const { t } = useTranslation('settings')
  const titleId = useId()
  const [open, setOpen] = useState<number | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const duplicates = duplicateNames(components.map((c) => c.name))
  const full = components.length >= COMPONENT_LIMITS.components
  const add = () => {
    onChange((list) => [...list, emptyComponent()])
    setOpen(components.length)
  }
  const remove = (index: number) => {
    onChange((list) => removeAt(list, index))
    setOpen(null)
    setRemoving(null)
  }
  const removingName = removing === null ? '' : components[removing]?.name.trim() ?? ''

  return (
    <section aria-labelledby={titleId} data-testid="design-components">
      <GroupLabel><span id={titleId}>{t('designSystem.components.title')}</span></GroupLabel>
      <p className="text-xs text-muted mb-2">{t('designSystem.components.hint')}</p>
      {components.length === 0 ? <p className="text-sm text-muted italic">{t(readOnly ? 'designSystem.components.emptyView' : 'designSystem.components.empty')}</p> : null}
      <ul className="space-y-2">
        {components.map((component, index) => (
          <ComponentRow
            key={index}
            component={component}
            colors={colors}
            readOnly={readOnly}
            duplicate={duplicates.has(component.name.trim().toLowerCase())}
            expanded={open === index}
            onToggle={() => setOpen(open === index ? null : index)}
            onChange={(change) => onChange((list) => updateAt(list, index, change))}
            onRemove={() => setRemoving(index)}
          />
        ))}
      </ul>
      {readOnly ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={add} disabled={full} className="btn btn-ghost btn-sm flex items-center gap-1.5">
            <Plus size={14} /> {t('designSystem.components.add')}
          </button>
          <span className="text-xs text-muted">{t('designSystem.components.countOf', { used: components.length, max: COMPONENT_LIMITS.components })}</span>
        </div>
      )}
      <ConfirmModal
        isOpen={removing !== null}
        title={t('designSystem.components.removeTitle')}
        message={t('designSystem.components.removeMessage', { name: removingName || t('designSystem.components.untitled') })}
        confirmLabel={t('designSystem.components.remove')}
        variant="danger"
        onConfirm={() => { if (removing !== null) remove(removing) }}
        onCancel={() => setRemoving(null)}
      />
    </section>
  )
}

interface RowProps {
  readonly component: DesignComponent
  readonly colors: readonly NamedValue[]
  readonly readOnly: boolean
  readonly duplicate: boolean
  readonly onChange: (change: (component: DesignComponent) => DesignComponent) => void
}

function ComponentRow({ component, colors, readOnly, duplicate, expanded, onToggle, onChange, onRemove }: RowProps & {
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onRemove: () => void
}) {
  const { t } = useTranslation('settings')
  const bodyId = useId()
  const name = component.name.trim() || t('designSystem.components.untitled')
  const first = component.variants.at(0)
  const Chevron = expanded ? ChevronDown : ChevronRight
  const removeLabel = t('designSystem.components.removeNamed', { name })
  return (
    <li className="rounded-md border border-border">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex-1 min-w-0 flex items-center gap-2 text-left rounded-md px-1 py-1 hover:bg-bg-hover"
        >
          <Chevron size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
          <span className="text-sm font-medium text-text-strong truncate">{name}</span>
          <span className="text-xs text-muted flex-shrink-0">{t('designSystem.components.variantsCount', { count: component.variants.length })}</span>
        </button>
        {first ? <span className="hidden sm:inline-flex"><MiniPreview component={component} variant={first} colors={colors} /></span> : null}
        {readOnly ? null : (
          <button type="button" onClick={onRemove} className="icon-btn" aria-label={removeLabel} title={removeLabel}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {expanded ? (
        <div id={bodyId} className="border-t border-border p-3 space-y-4">
          {readOnly
            ? <ComponentView component={component} colors={colors} />
            : <ComponentBody component={component} colors={colors} duplicate={duplicate} onChange={onChange} />}
        </div>
      ) : null}
    </li>
  )
}

function ComponentView({ component, colors }: Readonly<{ component: DesignComponent; colors: readonly NamedValue[] }>) {
  return (
    <>
      {component.description ? <p className="text-sm text-text">{component.description}</p> : null}
      <ul className="space-y-3">
        {component.variants.map((variant, i) => <VariantView key={i} component={component} variant={variant} colors={colors} />)}
      </ul>
      <ExampleSection component={component} />
    </>
  )
}

function ComponentBody({ component, colors, duplicate, onChange }: Omit<RowProps, 'readOnly'>) {
  const { t } = useTranslation('settings')
  const nameId = useId()
  const descriptionId = useId()
  const nameError = component.name.trim() === '' ? t('designSystem.components.nameRequired') : null
  const error = nameError ?? (duplicate ? t('designSystem.components.nameTaken') : null)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div>
          <label htmlFor={nameId} className="block text-xs text-muted mb-0.5">{t('designSystem.components.name')}</label>
          <input
            id={nameId}
            value={component.name}
            maxLength={COMPONENT_LIMITS.name}
            placeholder={t('designSystem.components.namePlaceholder')}
            aria-invalid={error !== null}
            aria-describedby={error ? `${nameId}-error` : undefined}
            onChange={(e) => onChange((c) => ({ ...c, name: e.target.value }))}
            className={clsx('input w-full', error && 'border-danger')}
          />
          {error ? <p id={`${nameId}-error`} className="text-xs text-danger mt-0.5">{error}</p> : null}
        </div>
        <div>
          <label htmlFor={descriptionId} className="block text-xs text-muted mb-0.5">{t('designSystem.components.description')}</label>
          <textarea
            id={descriptionId}
            rows={2}
            value={component.description}
            maxLength={COMPONENT_LIMITS.description}
            placeholder={t('designSystem.components.descriptionPlaceholder')}
            onChange={(e) => onChange((c) => ({ ...c, description: e.target.value }))}
            className="input w-full"
          />
        </div>
      </div>
      <VariantList component={component} colors={colors} onChange={onChange} />
      <ExampleSection component={component} onChange={onChange} />
    </>
  )
}

function VariantList({ component, colors, onChange }: Readonly<{
  component: DesignComponent
  colors: readonly NamedValue[]
  onChange: RowProps['onChange']
}>) {
  const { t } = useTranslation('settings')
  const { variants } = component
  const duplicates = duplicateNames(variants.map((v) => v.name))
  const setVariants = (change: (list: ComponentVariant[]) => ComponentVariant[]) => onChange((c) => ({ ...c, variants: change(c.variants) }))
  const addVariant = () => setVariants((list) => [...list, emptyVariant(nextVariantName(list, t('designSystem.components.variantBase')))])
  return (
    <div>
      <p className="text-xs font-medium text-muted-strong mb-2">{t('designSystem.components.variants')}</p>
      <ul className="space-y-3">
        {variants.map((variant, i) => (
          <VariantEditor
            key={i}
            component={component}
            variant={variant}
            colors={colors}
            duplicate={duplicates.has(variant.name.trim().toLowerCase())}
            canRemove={variants.length > 1}
            onChange={(change) => setVariants((list) => updateAt(list, i, change))}
            onRemove={() => setVariants((list) => removeAt(list, i))}
          />
        ))}
      </ul>
      <button type="button" onClick={addVariant} disabled={variants.length >= COMPONENT_LIMITS.variants} className="btn btn-ghost btn-sm flex items-center gap-1.5 mt-2">
        <Plus size={14} /> {t('designSystem.components.addVariant')}
      </button>
    </div>
  )
}

/** Advanced: the example HTML (edited as text when `onChange` is given; shown only in a sandboxed frame). */
function ExampleSection({ component, onChange }: Readonly<{
  component: DesignComponent
  onChange?: RowProps['onChange']
}>) {
  const { t } = useTranslation('settings')
  const id = useId()
  const html = component.example_html ?? ''
  if (!onChange && html.trim() === '') return null
  const frameTitle = t('designSystem.components.exampleFrame', { name: component.name.trim() || t('designSystem.components.untitled') })
  return (
    <details className="rounded-md border border-border p-2">
      <summary className="text-xs font-medium text-text cursor-pointer">{t('designSystem.components.advanced')}</summary>
      <div className="mt-2 space-y-2">
        {onChange ? (
          <>
            <label htmlFor={id} className="block text-xs text-muted">{t('designSystem.components.exampleHtml')}</label>
            <textarea
              id={id}
              rows={4}
              value={html}
              maxLength={COMPONENT_LIMITS.exampleHtml}
              onChange={(e) => onChange((c) => ({ ...c, example_html: e.target.value }))}
              className="input w-full font-mono text-xs"
            />
            <p className="text-xs text-muted">{t('designSystem.components.exampleHint')}</p>
          </>
        ) : null}
        {html.trim() === '' ? null : <ExampleFrame html={html} title={frameTitle} />}
      </div>
    </details>
  )
}
