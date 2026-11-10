/**
 * @fileoverview What applying a reference would change: per token group, how
 * many tokens are new and how many replace a saved one (same name, or same role
 * for typography), and whether the guidelines change. Compares the SAVED design
 * system with the draft the apply route returned, which is what Save would store.
 *
 * Also the counts and font list a reference preview shows.
 *
 * @module pages/Company/designDraftSummary
 */
import { toWireComponents } from '../../api/designComponents'
import type { DesignComponent } from '../../api/designComponents'
import type { DesignTokens, ExtractedDesign } from '../../api/designSystemApi'

const TOKEN_GROUPS = ['colors', 'typography', 'spacing', 'radius'] as const
export type TokenGroup = typeof TOKEN_GROUPS[number]

export interface GroupChange {
  group: TokenGroup
  added: number
  replaced: number
}

export interface ComponentChange {
  added: number
  replaced: number
}

export interface DraftSummary {
  /** Only the groups with at least one added or replaced token, in TOKEN_GROUPS order. */
  groups: GroupChange[]
  /** Components new in the draft / replacing a saved one of the same name (case-insensitive). */
  components: ComponentChange
  guidelinesChanged: boolean
  /** False when the draft equals the saved design system (nothing to review). */
  changed: boolean
}

interface Editable {
  tokens: DesignTokens
  guidelines: string
  components: DesignComponent[]
}

/** One token row keyed the way the merge rule matches it: name, or role for typography. */
function keyedRows(tokens: DesignTokens, group: TokenGroup): Map<string, string> {
  const rows: Array<[string, string]> = group === 'typography'
    ? tokens.typography.map((row): [string, string] => [row.role, JSON.stringify(row)])
    : tokens[group].map((row): [string, string] => [row.name, JSON.stringify(row)])
  return new Map(rows)
}

function groupChange(saved: DesignTokens, draft: DesignTokens, group: TokenGroup): GroupChange {
  const before = keyedRows(saved, group)
  const after = [...keyedRows(draft, group)]
  const added = after.filter(([key]) => !before.has(key)).length
  const replaced = after.filter(([key, row]) => before.has(key) && before.get(key) !== row).length
  return { group, added, replaced }
}

/** Components keyed the way the apply merge matches them: lower-cased name → wire JSON. */
function keyedComponents(components: readonly DesignComponent[]): Map<string, string> {
  const wire = toWireComponents(components)
  return new Map(components.map((component, i): [string, string] => [component.name.trim().toLowerCase(), JSON.stringify(wire[i])]))
}

function componentChange(saved: readonly DesignComponent[], draft: readonly DesignComponent[]): ComponentChange {
  const before = keyedComponents(saved)
  const after = [...keyedComponents(draft)]
  return {
    added: after.filter(([key]) => !before.has(key)).length,
    replaced: after.filter(([key, row]) => before.has(key) && before.get(key) !== row).length,
  }
}

export function summarizeDraft(saved: Editable, draft: Editable): DraftSummary {
  const groups = TOKEN_GROUPS
    .map((group) => groupChange(saved.tokens, draft.tokens, group))
    .filter((change) => change.added > 0 || change.replaced > 0)
  const components = componentChange(saved.components, draft.components)
  const guidelinesChanged = draft.guidelines.trim() !== saved.guidelines.trim()
  const componentsChanged = components.added + components.replaced > 0
  return { groups, components, guidelinesChanged, changed: groups.length > 0 || componentsChanged || guidelinesChanged }
}

export interface FontFamily {
  /** The stack's first family, unquoted ("Space Grotesk"). */
  name: string
  /** The full stack as read ("'Space Grotesk', system-ui, sans-serif"). */
  stack: string
}

/** The first family of a CSS font stack, without quotes. */
export function firstFamily(stack: string): string {
  const first = stack.split(',')[0] ?? ''
  return first.trim().replace(/^["']|["']$/g, '').trim()
}

/** The distinct font families a reference uses (by first name), in first-seen order. */
export function fontFamilies(design: ExtractedDesign): FontFamily[] {
  const seen = new Map<string, FontFamily>()
  for (const row of design.typography) {
    const stack = row.family.trim()
    const name = firstFamily(stack)
    if (name !== '' && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, stack })
  }
  return [...seen.values()]
}

export interface DesignCounts {
  colors: number
  fonts: number
  spacing: number
  radii: number
  components: number
  variants: number
}

export function designCounts(design: ExtractedDesign): DesignCounts {
  return {
    colors: design.colors.length,
    fonts: fontFamilies(design).length,
    spacing: design.spacing.length,
    radii: design.radius.length,
    components: design.components.length,
    variants: design.components.reduce((sum, component) => sum + component.variants.length, 0),
  }
}

/** True when the reference yielded anything the design system could take. */
export function hasDesign(design: ExtractedDesign | undefined): design is ExtractedDesign {
  if (!design) return false
  const counts = Object.values(designCounts(design))
  return counts.some((count) => count > 0) || design.guidelines_md.trim() !== '' || design.logo !== null
}

/** The host of a URL ("kirocrew.dev"), or '' when it does not parse. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
