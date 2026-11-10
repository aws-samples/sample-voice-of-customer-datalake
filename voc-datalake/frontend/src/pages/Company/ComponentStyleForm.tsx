/**
 * @fileoverview The style form of one component variant: colours (swatch +
 * "Use token…" that writes `var:<token name>`), shape, text, shadow, and a
 * collapsed "Hover and focus" sub-form. Every field says when its value is not
 * one the design system accepts; the preview ignores such a value.
 *
 * @module pages/Company/ComponentStyleForm
 */
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import {
  COLOR_KEYS, HOVER_KEYS, SHAPE_KEYS, TEXT_TRANSFORMS, isValidOutline, isValidStyleValue,
} from '../../api/designComponents'
import type { ComponentVariant, FocusKey, HoverKey, StyleKey } from '../../api/designComponents'
import type { NamedValue } from '../../api/designSystemApi'
import { resolveColor } from './componentPreviewStyle'

const PLACEHOLDERS: Readonly<Record<StyleKey, string>> = {
  background: '#8e48ff', color: '#ffffff', border_color: '#352f3d',
  border_width: '1px', radius: '8px', padding: '8px 16px', gap: '8px', height: '36px', width: '36px',
  font_family: 'Inter, sans-serif', font_size: '14px', font_weight: '600', letter_spacing: '0.01em',
  text_transform: '', shadow: '0 1px 2px rgba(0,0,0,0.2)',
}
const TEXT_FIELDS = ['font_family', 'font_size', 'font_weight', 'letter_spacing'] as const satisfies readonly StyleKey[]
const COLOR_SET: ReadonlySet<string> = new Set(COLOR_KEYS)
/** The focus ring's keys beside the outline: its border colour and its glow. */
const RING_KEYS = ['border_color', 'shadow'] as const satisfies readonly FocusKey[]

type Change = (change: (variant: ComponentVariant) => ComponentVariant) => void

interface FormProps {
  readonly variant: ComponentVariant
  readonly colors: readonly NamedValue[]
  readonly onChange: Change
}

export default function ComponentStyleForm({ variant, colors, onChange }: FormProps) {
  const { t } = useTranslation('settings')
  const setStyle = (key: StyleKey, value: string) => onChange((v) => ({ ...v, styles: { ...v.styles, [key]: value } }))
  const field = (key: StyleKey) => (
    <StyleField key={key} styleKey={key} value={variant.styles[key] ?? ''} colors={colors} onValue={(value) => setStyle(key, value)} />
  )
  return (
    <div className="space-y-3">
      <FieldGroup title={t('designSystem.components.groups.colors')} columns="sm:grid-cols-2">{COLOR_KEYS.map(field)}</FieldGroup>
      <FieldGroup title={t('designSystem.components.groups.shape')}>{SHAPE_KEYS.map(field)}</FieldGroup>
      <FieldGroup title={t('designSystem.components.groups.text')}>
        {TEXT_FIELDS.map(field)}
        <TextTransformField value={variant.styles.text_transform ?? ''} onValue={(value) => setStyle('text_transform', value)} />
        {field('shadow')}
      </FieldGroup>
      <HoverFocusForm variant={variant} colors={colors} onChange={onChange} />
    </div>
  )
}

function FieldGroup({ title, columns = 'sm:grid-cols-2 lg:grid-cols-3', children }: Readonly<{ title: string; columns?: string; children: ReactNode }>) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted-strong mb-1">{title}</legend>
      <div className={clsx('grid gap-2', columns)}>{children}</div>
    </fieldset>
  )
}

/** The hover overrides and the focus ring (outline, border colour, glow), collapsed until opened. */
function HoverFocusForm({ variant, colors, onChange }: FormProps) {
  const { t } = useTranslation('settings')
  const setHover = (key: HoverKey, value: string) => onChange((v) => ({ ...v, hover: { ...v.hover, [key]: value } }))
  const setFocus = (key: FocusKey, value: string) => onChange((v) => ({ ...v, focus: { ...v.focus, [key]: value } }))
  const outline = variant.focus.outline ?? ''
  return (
    <details className="rounded-md border border-border p-2">
      <summary className="text-xs font-medium text-text cursor-pointer">{t('designSystem.components.hoverFocus')}</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {HOVER_KEYS.map((key) => (
          <StyleField
            key={key}
            styleKey={key}
            label={t('designSystem.components.hoverField', { field: t(`designSystem.components.fields.${key}`) })}
            value={variant.hover[key] ?? ''}
            colors={colors}
            onValue={(value) => setHover(key, value)}
          />
        ))}
        <TextField
          label={t('designSystem.components.fields.outline')}
          value={outline}
          placeholder={t('designSystem.components.example', { value: '2px solid #8e48ff' })}
          invalid={!isValidOutline(outline)}
          invalidText={t('designSystem.components.invalid.outline')}
          onValue={(value) => setFocus('outline', value)}
        />
        {RING_KEYS.map((key) => (
          <StyleField
            key={`focus-${key}`}
            styleKey={key}
            label={t('designSystem.components.focusField', { field: t(`designSystem.components.fields.${key}`) })}
            value={variant.focus[key] ?? ''}
            colors={colors}
            onValue={(value) => setFocus(key, value)}
          />
        ))}
      </div>
    </details>
  )
}

function StyleField({ styleKey, label, value, colors, onValue }: Readonly<{
  styleKey: StyleKey
  label?: string
  value: string
  colors: readonly NamedValue[]
  onValue: (value: string) => void
}>) {
  const { t } = useTranslation('settings')
  const fieldLabel = label ?? t(`designSystem.components.fields.${styleKey}`)
  const isColor = COLOR_SET.has(styleKey)
  const text = (
    <TextField
      label={fieldLabel}
      labelHidden={isColor}
      value={value}
      placeholder={t('designSystem.components.example', { value: PLACEHOLDERS[styleKey] })}
      invalid={!isValidStyleValue(styleKey, value)}
      invalidText={t(`designSystem.components.invalid.${COLOR_SET.has(styleKey) ? 'color' : styleKey}`)}
      onValue={onValue}
    />
  )
  if (!isColor) return text
  return <ColorField label={fieldLabel} value={value} colors={colors} onValue={onValue}>{text}</ColorField>
}

/** A colour text field with its swatch and the token picker. */
function ColorField({ label, value, colors, onValue, children }: Readonly<{
  label: string
  value: string
  colors: readonly NamedValue[]
  onValue: (value: string) => void
  children: ReactNode
}>) {
  const { t } = useTranslation('settings')
  const painted = resolveColor(value, colors)
  const named = colors.filter((color) => color.name.trim() !== '')
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted mb-0.5" aria-hidden="true">{label}</p>
      <div className="flex flex-wrap items-start gap-2">
        <span
          role="img"
          aria-label={painted ? t('designSystem.swatch', { value: painted }) : t('designSystem.components.noColor')}
          className={clsx('w-8 h-8 mt-0.5 rounded-md border border-border-strong flex-shrink-0', !painted && 'bg-bg-hover')}
          style={painted ? { backgroundColor: painted } : undefined}
        />
        <div className="flex-1 min-w-[7rem]">{children}</div>
        {named.length > 0 ? (
          <select
            aria-label={t('designSystem.components.useTokenFor', { field: label })}
            value=""
            onChange={(e) => { if (e.target.value) onValue(`var:${e.target.value}`) }}
            className="select w-auto flex-shrink-0 whitespace-nowrap"
          >
            <option value="">{t('designSystem.components.useToken')}</option>
            {named.map((color) => <option key={color.name} value={color.name.trim()}>{color.name}</option>)}
          </select>
        ) : null}
      </div>
    </div>
  )
}

function FieldLabel({ htmlFor, children }: Readonly<{ htmlFor: string; children: ReactNode }>) {
  return <label htmlFor={htmlFor} className="block text-xs text-muted mb-0.5">{children}</label>
}

function TextTransformField({ value, onValue }: Readonly<{ value: string; onValue: (value: string) => void }>) {
  const { t } = useTranslation('settings')
  const id = useId()
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={id}>{t('designSystem.components.fields.text_transform')}</FieldLabel>
      <select id={id} value={value} onChange={(e) => onValue(e.target.value)} className="select w-full">
        <option value="">{t('designSystem.components.notSet')}</option>
        {TEXT_TRANSFORMS.map((option) => <option key={option} value={option}>{t(`designSystem.components.transforms.${option}`)}</option>)}
      </select>
    </div>
  )
}

function TextField({ label, labelHidden = false, value, placeholder, invalid, invalidText, onValue }: Readonly<{
  label: string
  /** The label is shown by the surrounding colour field; kept for assistive tech. */
  labelHidden?: boolean
  value: string
  placeholder: string
  invalid: boolean
  invalidText: string
  onValue: (value: string) => void
}>) {
  const id = useId()
  return (
    <div className="min-w-0">
      {labelHidden ? <label htmlFor={id} className="sr-only">{label}</label> : <FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => onValue(e.target.value)}
        className={clsx('input w-full font-mono', invalid && 'border-danger')}
      />
      {invalid ? <p id={`${id}-error`} className="text-xs text-danger mt-0.5">{invalidText}</p> : null}
    </div>
  )
}
