/**
 * @fileoverview What every builder tab is given besides the draft: the part of the path after the tab, a way to go
 * elsewhere in this form's builder, and the builder's page-level actions (Improve with AI, which the Questions tab and
 * the header's ⋯ both open).
 *
 * @module pages/FeedbackForms/builder/builderUi
 */
import { createContext, useContext } from 'react'
import type { BuilderTab } from './builderPaths'

export interface BuilderUi {
  /** The form's id; null while it is a new, unsaved form. */
  readonly formId: string | null
  /** The path segments after the tab (`/questions/q_reason` → `['q_reason']`). */
  readonly rest: readonly string[]
  /** Go to a tab of this form (and what is open in it); `replace` keeps the history entry. */
  readonly go: (tab: BuilderTab, rest?: readonly string[], options?: { readonly replace?: boolean }) => void
  /** Open "Improve with AI" (UX §12.2). */
  readonly openImprove: () => void
  /**
   * Leave the builder for `path` without the unsaved-changes question: for a leave the person already confirmed
   * (Discard draft, Delete form). `state` is the history state the next page reads.
   */
  readonly leave: (path: string, state?: unknown) => void
}

export const BuilderUiContext = createContext<BuilderUi | null>(null)

export function useBuilderUi(): BuilderUi {
  const ui = useContext(BuilderUiContext)
  if (ui === null) throw new Error('useBuilderUi is used outside a form builder page.')
  return ui
}
