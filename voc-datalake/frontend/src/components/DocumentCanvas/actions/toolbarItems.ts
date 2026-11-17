/**
 * @fileoverview The buttons of the document page's toolbar (DocumentToolbar), in their order, and which of them step
 * into its "⋯" menu on a narrow screen:
 *
 * History · AI review · AI rewrite · Comments · Contents · Full width · Full screen (the version picker before them and
 * Share after them are the toolbar's own). Each is a door to a state or an action the page already has: the View
 * menu's switches (canvasMenus.ts `viewEntries` reads the same `CanvasViewControls`), the focus view, the Document
 * menu's History, and the comment rail's two AI flows (`ReviewActions`: "Ask personas to review", "Revise from
 * comments"). An item absent from the list is not offered: AI review and AI rewrite for whoever may not run them
 * (a viewer), History for a document edited elsewhere (a decision), Comments for a document without comments.
 *
 * @module components/DocumentCanvas/actions/toolbarItems
 */
import { History, Maximize2, MessageSquare, Minimize2, MoveHorizontal, TableOfContents, UsersRound, WandSparkles } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import type { CanvasMenuEntry } from './CanvasMenu'
import type { CanvasViewControls, ViewToggle } from './canvasMenus'

/** The comment rail's two AI flows, as the toolbar runs them (DocumentReviewView reports them). */
export interface ReviewActions {
  /**
   * "Ask personas to review": personas read this version and comment. `blocked`: the project has no personas;
   * `again`: a "Revise from comments" pass has run, so the review would be of its result.
   */
  readonly review: { readonly running: boolean; readonly blocked: boolean; readonly again: boolean; readonly start: () => void }
  /** "Revise from comments" (an editable canvas only, else null); `reason`: why a pass cannot start now. */
  readonly rewrite: { readonly running: boolean; readonly reason: string | null; readonly start: () => void } | null
}

export interface ToolbarItem {
  readonly id: string
  /** Its name (a count it shows included). */
  readonly label: string
  /** Its name in the "⋯" menu (no count). */
  readonly menuLabel: string
  /** Its tooltip. */
  readonly hint: string
  readonly icon: LucideIcon
  /** A toggle's state (`aria-pressed`); absent for an action. */
  readonly pressed?: boolean
  readonly badge?: number
  readonly disabled?: boolean
  readonly busy?: boolean
  readonly opensDialog?: boolean
  readonly keyShortcuts?: string
  /** Into "⋯" on a narrow screen. */
  readonly overflows: boolean
  readonly run: () => void
}

export interface ToolbarInputs {
  readonly view?: CanvasViewControls
  /** The open comment threads (absent: not loaded yet, or no comments). */
  readonly openThreads?: number
  readonly focus: ViewToggle
  /** History (null: no versions here). */
  readonly onHistory: (() => void) | null
  /** Null for whoever may not run them, and while an older version is on screen. */
  readonly review: ReviewActions | null
}


function toggleItem(id: string, label: string, hint: string, icon: LucideIcon, toggle: ViewToggle, overflows: boolean): ToolbarItem {
  return { id, label, menuLabel: label, hint, icon, pressed: toggle.on, overflows, run: toggle.toggle }
}

function reviewItems(review: ReviewActions | null, t: TFunction<'projectDetail'>): ToolbarItem[] {
  if (review === null) return []
  const { review: personas, rewrite } = review
  const ask = t('documents:toolbar.aiReview')
  const askHint = (() => {
    if (personas.running) return t('components:documentComments.personaReviewRunning')
    if (personas.blocked) return t('documents:toolbar.aiReviewNoPersonas')
    return personas.again ? t('canvas.revise.reviewAgain') : t('components:documentComments.personaReviewHint')
  })()
  const items: ToolbarItem[] = [{
    id: 'aiReview', label: ask, menuLabel: ask, icon: UsersRound, overflows: true, run: personas.start, hint: askHint,
    disabled: personas.blocked, busy: personas.running,
  }]
  if (rewrite === null) return items
  const rewriteLabel = t('documents:toolbar.aiRewrite')
  return [...items, {
    id: 'aiRewrite', label: rewriteLabel, menuLabel: rewriteLabel, icon: WandSparkles, overflows: true, run: rewrite.start,
    hint: rewrite.running ? t('canvas.revise.running') : (rewrite.reason ?? t('canvas.revise.hint')),
    disabled: rewrite.reason !== null, busy: rewrite.running,
  }]
}

function commentsItem(view: CanvasViewControls | undefined, openThreads: number | undefined, t: TFunction<'projectDetail'>): ToolbarItem[] {
  const comments = view?.comments
  if (comments === undefined) return []
  const name = t('documents:menubar.comments')
  return [{
    ...toggleItem('comments', name, t('documents:menubar.commentsHint'), MessageSquare, comments, false),
    label: openThreads === undefined ? name : t('documents:menubar.commentsButton', { count: openThreads }),
    badge: openThreads,
  }]
}

/** The toolbar's buttons, in order (see the module's doc). */
export function toolbarItems({ view, openThreads, focus, onHistory, review }: ToolbarInputs, t: TFunction<'projectDetail'>): ToolbarItem[] {
  const history: ToolbarItem[] = onHistory === null ? [] : [{
    id: 'history', label: t('documents:actions.history'), menuLabel: t('documents:actions.history'),
    hint: t('documents:toolbar.historyHint'), icon: History, opensDialog: true, overflows: true, run: onHistory,
  }]
  const panels: ToolbarItem[] = view === undefined ? [] : [
    toggleItem('outline', t('documents:page.contents'), t('documents:toolbar.contentsHint'), TableOfContents, view.outline, true),
    toggleItem('fullWidth', t('documents:menubar.fullWidth'), t('documents:toolbar.fullWidthHint'), MoveHorizontal, view.fullWidth, true),
  ]
  return [
    ...history,
    ...reviewItems(review, t),
    ...commentsItem(view, openThreads, t),
    ...panels,
    {
      ...toggleItem('fullScreen', t('documents:focus.button'), t('documents:focus.hint'), focus.on ? Minimize2 : Maximize2, focus, false),
      keyShortcuts: 'Control+Shift+F Meta+Shift+F',
    },
  ]
}

/** An item as an entry of the "⋯" menu: a toggle as a checkbox item, an action as an item (disabled while it runs). */
export function overflowEntry(item: ToolbarItem): CanvasMenuEntry {
  if (item.pressed !== undefined) {
    return { kind: 'toggle', id: item.id, label: item.menuLabel, checked: item.pressed, onToggle: item.run }
  }
  return {
    kind: 'action', id: item.id, label: item.menuLabel, icon: item.icon, onSelect: item.run,
    disabled: item.disabled === true || item.busy === true,
  }
}
