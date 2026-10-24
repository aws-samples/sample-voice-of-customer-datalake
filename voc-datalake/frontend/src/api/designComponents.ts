/**
 * @fileoverview Design-system components (THE CONTRACT, wave 13): a component's
 * variants and the style values each variant carries, as stored in the design
 * system (`components`) and in a reference's `extracted_design.components`.
 *
 * The server validates and sanitises every value; this module mirrors those
 * rules so the editor can flag a bad value before Save, and so the live preview
 * paints ONLY values that pass them (a style value never reaches the page
 * unchecked). `var:<token name>` in a colour field points at a colour token.
 *
 * @module api/designComponents
 */
import { z } from 'zod'
import { lenientText as text, optionalText, parsedList } from './schemaList'

export const COMPONENT_LIMITS = {
  components: 30,
  variants: 6,
  name: 60,
  description: 300,
  variantName: 40,
  shadow: 200,
  outline: 80,
  exampleHtml: 2000,
  /** A colour value (tokens and styles share the token editor's cap). */
  colorValue: 120,
} as const

export const COLOR_KEYS = ['background', 'color', 'border_color'] as const
export const SHAPE_KEYS = ['border_width', 'radius', 'padding', 'gap', 'height'] as const
const TEXT_KEYS = ['font_family', 'font_size', 'font_weight', 'letter_spacing', 'text_transform'] as const
export const STYLE_KEYS = [...COLOR_KEYS, ...SHAPE_KEYS, ...TEXT_KEYS, 'shadow'] as const
export const HOVER_KEYS = ['background', 'color', 'border_color', 'shadow'] as const
const FOCUS_KEYS = ['outline'] as const
export const TEXT_TRANSFORMS = ['none', 'uppercase', 'capitalize'] as const

export type ColorKey = typeof COLOR_KEYS[number]
export type StyleKey = typeof STYLE_KEYS[number]
export type HoverKey = typeof HOVER_KEYS[number]
type VariantStyles = Partial<Record<StyleKey, string>>
type HoverStyles = Partial<Record<HoverKey, string>>
interface FocusStyles { outline?: string }

export interface ComponentVariant {
  name: string
  styles: VariantStyles
  /** Always an object in the editor; dropped from the wire when empty. */
  hover: HoverStyles
  focus: FocusStyles
}

export interface DesignComponent {
  name: string
  description: string
  variants: ComponentVariant[]
  example_html?: string
}

// ── The value rules (mirrors lambda/shared/company_context.py) ─────────────────

const HEX_COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION_COLOR_RE = /^(rgba?|hsla?|oklch|oklab|lab|lch)\([0-9.%\s,/+-]+\)$/i
const KEYWORD_COLOR_RE = /^[a-z]{3,30}$/i
const LENGTH = String.raw`(0|\d{1,4}(\.\d{1,3})?(px|rem|em|%|pt|vh|vw))`
const LENGTH_RE = new RegExp(`^${LENGTH}$`)
const PADDING_RE = new RegExp(`^${LENGTH}(\\s+${LENGTH}){0,3}$`)
const LETTER_SPACING_RE = new RegExp(`^(normal|-?${LENGTH})$`)
const FONT_FAMILY_RE = /^[\p{L}\p{N}_\s,"'.-]{1,200}$/u
const WEIGHT_RE = /^([1-9]00|normal|bold|lighter|bolder)$/
/** A CSS box-shadow / outline: plain values and colour functions only — no url(), expression(), braces or quotes. */
const PAINT_LIST_RE = /^[\w\s#.,()%/+-]+$/
const FORBIDDEN_FUNCTION_RE = /(url|expression|var|image|attr)\s*\(/i
const TOKEN_REF_RE = /^var:(\S(?:.{0,58}\S)?)$/u

/** The colour token a `var:<name>` value points at, or null when it is not a token reference. */
export function tokenRefName(value: string): string | null {
  const match = TOKEN_REF_RE.exec(value.trim())
  return match?.[1] ?? null
}

export function isCssColor(value: string): boolean {
  const v = value.trim()
  return value.length <= COMPONENT_LIMITS.colorValue
    && (HEX_COLOR_RE.test(v) || FUNCTION_COLOR_RE.test(v) || KEYWORD_COLOR_RE.test(v))
}

function isPaintList(value: string, max: number): boolean {
  const v = value.trim()
  return v.length > 0 && v.length <= max && PAINT_LIST_RE.test(v) && !FORBIDDEN_FUNCTION_RE.test(v)
}

const isColorOrToken = (value: string) => isCssColor(value) || tokenRefName(value) !== null
const isLength = (value: string) => LENGTH_RE.test(value.trim())

const STYLE_RULES: Readonly<Record<StyleKey, (value: string) => boolean>> = {
  background: isColorOrToken,
  color: isColorOrToken,
  border_color: isColorOrToken,
  border_width: isLength,
  radius: isLength,
  padding: (value) => PADDING_RE.test(value.trim()),
  gap: isLength,
  height: isLength,
  font_family: (value) => FONT_FAMILY_RE.test(value.trim()),
  font_size: isLength,
  font_weight: (value) => WEIGHT_RE.test(value.trim()),
  letter_spacing: (value) => LETTER_SPACING_RE.test(value.trim()),
  text_transform: (value) => TEXT_TRANSFORMS.some((option) => option === value.trim()),
  shadow: (value) => isPaintList(value, COMPONENT_LIMITS.shadow),
}

/** Whether a style value passes THE CONTRACT's rule for its key. An empty value is "not set", which is valid. */
export function isValidStyleValue(key: StyleKey, value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true
  return STYLE_RULES[key](value)
}

export function isValidOutline(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true
  return isPaintList(value, COMPONENT_LIMITS.outline)
}

// ── Reading (lenient: unknown keys and non-string values are dropped) ─────────

function pickStrings<K extends string>(keys: readonly K[]) {
  return z.record(z.string(), z.unknown()).catch({}).transform((raw) => {
    const picked: Partial<Record<K, string>> = {}
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string' && value.trim() !== '') picked[key] = value
    }
    return picked
  })
}

const VariantSchema = z.object({
  name: text,
  styles: pickStrings(STYLE_KEYS),
  hover: pickStrings(HOVER_KEYS),
  focus: pickStrings(FOCUS_KEYS),
})

const ComponentSchema = z.object({
  name: z.string().min(1),
  description: text,
  variants: parsedList(VariantSchema),
  example_html: optionalText,
})

export const componentList = parsedList(ComponentSchema)

// ── Writing ──────────────────────────────────────────────────────────────────

function trimmed<K extends string>(keys: readonly K[], styles: Partial<Record<K, string>>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = styles[key]?.trim() ?? ''
    if (value !== '') out[key] = value
  }
  return out
}

const hasKeys = (value: object) => Object.keys(value).length > 0

/** THE CONTRACT wire shape: trimmed values, empty styles / hover / focus / example dropped. */
export function toWireComponents(components: readonly DesignComponent[]): unknown[] {
  return components.map((component) => {
    const example = component.example_html?.trim() ?? ''
    return {
      name: component.name.trim(),
      description: component.description.trim(),
      variants: component.variants.map((variant) => {
        const hover = trimmed(HOVER_KEYS, variant.hover)
        const focus = trimmed(FOCUS_KEYS, variant.focus)
        return {
          name: variant.name.trim(),
          styles: trimmed(STYLE_KEYS, variant.styles),
          ...(hasKeys(hover) ? { hover } : {}),
          ...(hasKeys(focus) ? { focus } : {}),
        }
      }),
      ...(example === '' ? {} : { example_html: example }),
    }
  })
}

function variantValid(variant: ComponentVariant): boolean {
  const name = variant.name.trim()
  return name !== '' && name.length <= COMPONENT_LIMITS.variantName
    && STYLE_KEYS.every((key) => isValidStyleValue(key, variant.styles[key]))
    && HOVER_KEYS.every((key) => isValidStyleValue(key, variant.hover[key]))
    && isValidOutline(variant.focus.outline)
}

function componentValid(component: DesignComponent): boolean {
  const name = component.name.trim()
  return name !== '' && name.length <= COMPONENT_LIMITS.name
    && component.description.length <= COMPONENT_LIMITS.description
    && (component.example_html ?? '').length <= COMPONENT_LIMITS.exampleHtml
    && component.variants.length <= COMPONENT_LIMITS.variants
    && component.variants.every(variantValid)
}

/** Names that appear more than once (case-insensitive), lower-cased. */
export function duplicateNames(names: readonly string[]): Set<string> {
  const keys = names.map((name) => name.trim().toLowerCase()).filter((key) => key !== '')
  return new Set(keys.filter((key, i) => keys.indexOf(key) !== i))
}

/** True when Save would be refused: a cap, an empty / duplicate name or a style value outside the rules. */
export function componentsInvalid(components: readonly DesignComponent[]): boolean {
  return components.length > COMPONENT_LIMITS.components
    || duplicateNames(components.map((c) => c.name)).size > 0
    || !components.every(componentValid)
}
