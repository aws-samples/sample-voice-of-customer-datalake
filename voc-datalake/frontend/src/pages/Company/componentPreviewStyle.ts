/**
 * @fileoverview Turns a component variant's style values into the React style
 * object its live preview paints with.
 *
 * Only values that pass THE CONTRACT's rules (api/designComponents) reach the
 * style object, and only through React's `style` prop — never a stylesheet or an
 * attribute string. `var:<name>` resolves to the current colour token of that
 * name (case-insensitive); an unknown token or an invalid value is left out, so
 * the preview falls back to its neutral look for that property.
 *
 * @module pages/Company/componentPreviewStyle
 */
import type { CSSProperties } from 'react'
import { COLOR_KEYS, isCssColor, isValidOutline, isValidStyleValue, tokenRefName } from '../../api/designComponents'
import type { ColorKey, ComponentVariant, StyleKey } from '../../api/designComponents'
import type { NamedValue } from '../../api/designSystemApi'

/** The paintable colour a colour field stands for: itself, or the colour token it names. */
export function resolveColor(value: string | undefined, colors: readonly NamedValue[]): string | undefined {
  const raw = value?.trim() ?? ''
  if (raw === '') return undefined
  const ref = tokenRefName(raw)
  if (ref === null) return isCssColor(raw) ? raw : undefined
  const wanted = ref.toLowerCase()
  const token = colors.find((color) => color.name.trim().toLowerCase() === wanted)
  return token && isCssColor(token.value) ? token.value.trim() : undefined
}

type StyleValues = Partial<Record<StyleKey, string>>

const COLOR_PROPERTIES: Readonly<Record<ColorKey, 'backgroundColor' | 'color' | 'borderColor'>> = {
  background: 'backgroundColor',
  color: 'color',
  border_color: 'borderColor',
}

const PLAIN_PROPERTIES = {
  border_width: 'borderWidth',
  radius: 'borderRadius',
  padding: 'padding',
  gap: 'gap',
  height: 'height',
  font_family: 'fontFamily',
  font_size: 'fontSize',
  font_weight: 'fontWeight',
  letter_spacing: 'letterSpacing',
  text_transform: 'textTransform',
  shadow: 'boxShadow',
} as const satisfies Partial<Record<StyleKey, keyof CSSProperties>>

type PlainKey = keyof typeof PLAIN_PROPERTIES
const PLAIN_KEYS = Object.keys(PLAIN_PROPERTIES).filter((key): key is PlainKey => key in PLAIN_PROPERTIES)

function colorEntries(values: StyleValues, colors: readonly NamedValue[]): Array<[string, string]> {
  return COLOR_KEYS.flatMap((key): Array<[string, string]> => {
    const resolved = resolveColor(values[key], colors)
    return resolved ? [[COLOR_PROPERTIES[key], resolved]] : []
  })
}

function plainEntries(values: StyleValues): Array<[string, string]> {
  return PLAIN_KEYS.flatMap((key): Array<[string, string]> => {
    const value = values[key]?.trim()
    return value && isValidStyleValue(key, value) ? [[PLAIN_PROPERTIES[key], value]] : []
  })
}

function toStyle(entries: Array<[string, string]>, base: CSSProperties): CSSProperties {
  return entries.reduce<CSSProperties>((style, [property, value]) => ({ ...style, [property]: value }), base)
}

export type PreviewState = 'default' | 'hover' | 'focus'

/**
 * The style for one state of a variant: its styles, with the hover values on top
 * for `hover` and the focus outline for `focus`. A border width or colour implies
 * a solid border, so an outlined button reads as one.
 */
export function variantStyle(variant: ComponentVariant, colors: readonly NamedValue[], state: PreviewState = 'default'): CSSProperties {
  const values: StyleValues = state === 'hover' ? { ...variant.styles, ...variant.hover } : variant.styles
  const hasBorder = [values.border_width, values.border_color].some((value) => (value?.trim() ?? '') !== '')
  const base: CSSProperties = hasBorder ? { borderStyle: 'solid', borderWidth: '1px' } : { borderStyle: 'none' }
  const style = toStyle([...plainEntries(values), ...colorEntries(values, colors)], base)
  const outline = variant.focus.outline?.trim()
  return state === 'focus' && outline && isValidOutline(outline) ? { ...style, outline, outlineOffset: '2px' } : style
}

export type PreviewElement = 'button' | 'input' | 'badge' | 'tab' | 'box'

const ELEMENT_PATTERNS: ReadonlyArray<[PreviewElement, RegExp]> = [
  ['button', /button|btn|cta|link/i],
  ['input', /input|field|text\s?area|select|search|form/i],
  ['badge', /badge|chip|tag|pill|label|status/i],
  ['tab', /tab/i],
]

/** Which real element previews a component, from its name ("Primary button" → a <button>); else a box (a card). */
export function previewElement(componentName: string): PreviewElement {
  return ELEMENT_PATTERNS.find(([, pattern]) => pattern.test(componentName))?.[0] ?? 'box'
}

/** The document the sandbox renders: the example inside a page whose own CSP forbids every load but inline styles / data: images. */
export function exampleDocument(html: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<style>body{margin:12px;font:14px system-ui,sans-serif}</style></head>'
    + `<body>${html}</body></html>`
}
