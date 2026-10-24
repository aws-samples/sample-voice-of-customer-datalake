/**
 * usePrototypeDesignSystem — the build dialog's "Design system" option.
 *
 * Given the company design system (`GET /settings/design-system`, any signed-in user,
 * already scoped to the caller's categories by the API — read by `useProjectData` beside
 * the product docs), answers three questions for the "Also read (optional)" list: is there
 * one, what will be read from it, and is the box ticked.
 *
 * Default ON when one exists — the industry default (a prototype follows the brand) and what
 * every build did before the option existed. Not remembered across builds, matching the
 * product-description and research boxes beside it (#320: per build, not per project).
 *
 * `known` is false while the read is pending or after it failed (`design` undefined): no
 * row is shown, rather than the dialog guessing "none". The request carries
 * `use_design_system` only when one is available (see `usePrototypeBuild`).
 *
 * @module pages/ProjectDetail/usePrototypeDesignSystem
 */
import { useState } from 'react'
import type { DesignSystem } from '../../api/designSystemApi'

/** What the design system holds, in the order the label lists it. */
export interface DesignSystemContents {
  readonly colours: boolean
  readonly type: boolean
  readonly spacing: boolean
  readonly guidelines: boolean
  /** Ready references with a summary — the only ones the prompt reads. */
  readonly references: number
  /** Component styles (buttons, inputs, cards…) — read as the prompt's Components section. */
  readonly components: number
}

export interface PrototypeDesignSystemOption {
  /** The read finished; false while loading or after a failed read. */
  readonly known: boolean
  /** Something the prompt would read exists (tokens, guidelines or a ready reference). */
  readonly available: boolean
  readonly contents: DesignSystemContents
  /** Ticked. Always false when nothing is available. */
  readonly use: boolean
  readonly onToggle: (next: boolean) => void
}

/** What `design_system_text` (lambda/shared/company_context.py) would put in the prompt. */
function designSystemContents(design: DesignSystem): DesignSystemContents {
  const { tokens } = design
  return {
    colours: tokens.colors.length > 0,
    type: tokens.typography.length > 0,
    spacing: tokens.spacing.length > 0 || tokens.radius.length > 0,
    guidelines: design.guidelines.trim() !== '',
    references: design.references
      .filter((ref) => ref.status === 'ready' && (ref.extracted_summary ?? '').trim() !== '').length,
    components: design.components.length,
  }
}

const NOTHING: DesignSystemContents = { colours: false, type: false, spacing: false, guidelines: false, references: 0, components: 0 }

function hasContents(contents: DesignSystemContents): boolean {
  return contents.colours || contents.type || contents.spacing || contents.guidelines || contents.references > 0 || contents.components > 0
}

export function usePrototypeDesignSystem(design: DesignSystem | undefined): PrototypeDesignSystemOption {
  // An override, not the value: unticked stays unticked, and until the person touches
  // the box it follows whether a design system exists (the default).
  const [choice, setChoice] = useState<boolean | null>(null)
  const contents = design === undefined ? NOTHING : designSystemContents(design)
  const available = hasContents(contents)
  return {
    known: design !== undefined,
    available,
    contents,
    use: available && (choice ?? true),
    onToggle: setChoice,
  }
}
