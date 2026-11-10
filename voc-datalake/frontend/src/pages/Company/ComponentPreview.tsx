/**
 * @fileoverview Live previews of a design-system component: a real element (a
 * `<button>`, an input, a badge, a tab or a card) painted from a variant's
 * validated style values, in its default, hover and focus states; a small
 * preview for the reference rows; and a component's example HTML.
 *
 * The samples are `inert` and hidden from assistive tech: they are pictures of
 * a control, not controls. Their colours are the company's OWN colours (user
 * data — see "Out of scope" in docs/kiro-design-system.md).
 *
 * Example HTML NEVER enters the app document: it is shown only inside an
 * `<iframe sandbox>` (no allow-scripts, no allow-same-origin → an opaque origin
 * with scripts, forms, popups and navigation all off) whose own CSP also blocks
 * every fetch but inline styles and data: images.
 *
 * @module pages/Company/ComponentPreview
 */
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentVariant, DesignComponent } from '../../api/designComponents'
import type { NamedValue } from '../../api/designSystemApi'
import { exampleDocument, previewElement, variantStyle } from './componentPreviewStyle'
import type { PreviewElement, PreviewState } from './componentPreviewStyle'

/** The neutral look a sample keeps for a property the variant does not set. */
const NEUTRAL: Readonly<Record<PreviewElement, CSSProperties>> = {
  button: { padding: '6px 14px', fontSize: '14px', borderRadius: '6px', cursor: 'default' },
  input: { padding: '6px 10px', fontSize: '14px', borderRadius: '6px', width: '11rem' },
  badge: { padding: '2px 8px', fontSize: '12px', borderRadius: '9999px' },
  tab: { padding: '6px 12px', fontSize: '14px' },
  box: { padding: '12px', fontSize: '14px', borderRadius: '8px', width: '11rem' },
}

/** What a sample says: the variant's name, else the component's. */
function sampleLabel(component: DesignComponent, variant: ComponentVariant): string {
  return variant.name.trim() || component.name.trim()
}

/** A mini preview's card / input: label only, no fixed width, so a row of them stays one line high. */
const COMPACT: CSSProperties = { width: 'auto', padding: '6px 10px', fontSize: '12px' }

function Sample({ element, label, style, compact = false }: Readonly<{ element: PreviewElement; label: string; style: CSSProperties; compact?: boolean }>) {
  const { t } = useTranslation('settings')
  const painted = { ...NEUTRAL[element], ...(compact ? COMPACT : {}), ...style }
  if (element === 'button') return <button type="button" tabIndex={-1} className="inline-flex items-center" style={painted}>{label}</button>
  if (element === 'input') return <input readOnly tabIndex={-1} aria-label={label} placeholder={label} style={painted} />
  if (element === 'box' && compact) return <span className="inline-flex items-center" style={painted}>{label}</span>
  if (element === 'box') {
    return (
      <div style={painted}>
        <p style={{ fontWeight: 600 }}>{label}</p>
        <p style={{ opacity: 0.75 }}>{t('designSystem.components.sampleText')}</p>
      </div>
    )
  }
  return <span className="inline-flex items-center" style={painted}>{label}</span>
}

const STATES: readonly PreviewState[] = ['default', 'hover', 'focus']

/** The variant in its three states, side by side, each captioned. */
export function VariantPreview({ component, variant, colors }: Readonly<{
  component: DesignComponent
  variant: ComponentVariant
  colors: readonly NamedValue[]
}>) {
  const { t } = useTranslation('settings')
  const element = previewElement(component.name)
  const label = sampleLabel(component, variant) || t('designSystem.components.untitled')
  return (
    <div className="self-start rounded-md border border-border bg-bg-accent p-3" data-testid="variant-preview">
      <p className="text-xs text-muted mb-2">{t('designSystem.components.livePreview')}</p>
      <div className="flex flex-wrap items-end gap-4" inert aria-hidden="true">
        {STATES.map((state) => (
          <figure key={state} className="space-y-1" data-state={state}>
            <Sample element={element} label={label} style={variantStyle(variant, colors, state)} />
            <figcaption className="text-xs text-muted">{t(`designSystem.components.states.${state}`)}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

/** One small default-state sample (reference rows, a collapsed component's header). */
export function MiniPreview({ component, variant, colors }: Readonly<{
  component: DesignComponent
  variant: ComponentVariant
  colors: readonly NamedValue[]
}>) {
  const label = sampleLabel(component, variant)
  return (
    <span className="inline-flex items-center" inert aria-hidden="true" data-testid="mini-preview">
      <Sample element={previewElement(component.name)} label={label} style={variantStyle(variant, colors)} compact />
    </span>
  )
}

/** A component's example HTML, isolated in a sandboxed frame (never in the app document). */
export function ExampleFrame({ html, title }: Readonly<{ html: string; title: string }>) {
  return (
    <iframe
      title={title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={exampleDocument(html)}
      className="w-full h-32 rounded-md border border-border bg-bg-elevated"
      data-testid="example-frame"
    />
  )
}
