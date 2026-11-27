/**
 * @fileoverview The buttons of the document page's toolbar (DocumentToolbar), in their order, and which of them step
 * into its "⋯" menu on a narrow screen:
 *
 * History · Persona review · Rewrite from comments · Comments · Contents · Full width · Full screen (the version
 * picker before them and Share after them are the toolbar's own). Each is a door to a state or an action the page
 * already has: the View menu's switches (canvasMenus.ts `viewEntries` reads the same `CanvasViewControls`), the focus
 * view, the Document menu's History, and the comment rail's two AI flows (`ReviewActions`: "Ask personas to review",
 * "Revise from comments"), which the menu bar's Review menu offers too (`reviewMenuEntries`, the same entries as the
 * "⋯" menu's). The two AI flows show their name beside the icon. An item absent from the list is not offered: the AI
 * flows for whoever may not run them (a viewer), History for a document edited elsewhere (a decision), Comments for a
 * document without comments. With nobody to ask (no persona in the project, none in the company library) the
 * persona review is "Add personas", which opens the project's Personas tab.
 *
 * @module components/DocumentCanvas/actions/toolbarItems
 */
import {
  History, Maximize2, MessageSquare, Minimize2, MoveHorizontal, TableOfContents, UserPlus, UsersRound, WandSparkles,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import type { CanvasMenuEntry } from './CanvasMenu'
import type { CanvasViewControls, ViewToggle } from './canvasMenus'

/**
 * Who a persona review asks: the project's own personas, the company's (the project has none: the server falls back
 * to its scope's company library), nobody ("Add personas"), or null: not known (the library is loading or could not
 * be read), so the review is offered and the server decides.
 */
export type ReviewPersonas = 'project' | 'company' | 'none' | null

/** The comment rail's two AI flows, as the toolbar runs them (DocumentReviewView reports them). */
export interface ReviewActions {
  /**
   * "Ask personas to review": personas read this version and comment. `again`: a "Revise from comments" pass has run,
   * so the review would be of its result. `addPersonas`: the project's Personas tab (offered when `personas` is
   * 'none').
   */
  readonly review: {
    readonly running: boolean; readonly personas: ReviewPersonas; readonly again: boolean; readonly start: () => void
    readonly addPersonas: () => void
  }
  /** "Revise from comments" (an editable canvas only, else null); `reason`: why a pass cannot start now. */
  readonly rewrite: { readonly running: boolean; readonly reason: string | null; readonly start: () => void } | null
}

/** What a toolbar button shows: an item's (below) and ToolbarButton's (toolbarControls.tsx). */
export interface ToolbarControl {
  /** Its name (a count it shows included). */
  readonly label: string
  /** Its tooltip. */
  readonly hint: string
  readonly icon: LucideIcon
  /** A toggle: whether it is on (`aria-pressed`); absent for an action. */
  readonly pressed?: boolean
  /** A count beside the icon (the open comments); its number is in `label`. */
  readonly badge?: number
  readonly disabled?: boolean
  /** Its action is running: a spinner in place of the icon. */
  readonly busy?: boolean
  /** It opens a dialog (History). */
  readonly opensDialog?: boolean
  readonly keyShortcuts?: string
  /** Its name shows beside its icon (the AI flows), not only in its tooltip. */
  readonly text?: boolean
}

export interface ToolbarItem extends ToolbarControl {
  readonly id: string
  /** Its name in the "⋯" menu (no count). */
  readonly menuLabel: string
  /** Into "⋯" on a narrow screen. */
  readonly overflows: boolean
  readonly run: () => void
  /** What its menu entry ("⋯", the Review menu) says under its name: why it is inert, that it runs, who reviews. */
  readonly menuNote?: string
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

/** The persona review's tooltip: running, again, by the company's personas, or the project's. */
function personaReviewHint(personas: ReviewActions['review'], t: TFunction<'projectDetail'>): string {
  if (personas.running) return t('components:documentComments.personaReviewRunning')
  if (personas.again) return t('canvas.revise.reviewAgain')
  return personas.personas === 'company'
    ? t('documents:toolbar.companyPersonasHint')
    : t('components:documentComments.personaReviewHint')
}

function personaReviewItem(personas: ReviewActions['review'], t: TFunction<'projectDetail'>): ToolbarItem {
  if (personas.personas === 'none' && !personas.running) {
    const add = t('documents:toolbar.addPersonas')
    return {
      id: 'aiReview', label: add, menuLabel: add, icon: UserPlus, overflows: true, text: true, run: personas.addPersonas,
      hint: t('documents:toolbar.addPersonasHint'), menuNote: t('documents:toolbar.addPersonasNote'),
    }
  }
  const ask = t('documents:toolbar.aiReview')
  const note = personas.running ? t('components:documentComments.personaReviewRunning') : undefined
  return {
    id: 'aiReview', label: ask, menuLabel: ask, icon: UsersRound, overflows: true, text: true, run: personas.start,
    hint: personaReviewHint(personas, t), busy: personas.running,
    menuNote: note ?? (personas.personas === 'company' ? t('documents:toolbar.companyPersonasNote') : undefined),
  }
}

function reviewItems(review: ReviewActions | null, t: TFunction<'projectDetail'>): ToolbarItem[] {
  if (review === null) return []
  const { rewrite } = review
  const items = [personaReviewItem(review.review, t)]
  if (rewrite === null) return items
  const rewriteLabel = t('documents:toolbar.aiRewrite')
  const inert = rewrite.running ? t('canvas.revise.running') : rewrite.reason
  return [...items, {
    id: 'aiRewrite', label: rewriteLabel, menuLabel: rewriteLabel, icon: WandSparkles, overflows: true, text: true,
    run: rewrite.start, hint: inert ?? t('canvas.revise.hint'), disabled: rewrite.reason !== null, busy: rewrite.running,
    menuNote: inert ?? undefined,
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

/**
 * An item as an entry of a menu ("⋯", the Review menu): a toggle as a checkbox item, an action as an item (inert while
 * it runs, a spinner in place of its icon), its note under its name.
 */
export function overflowEntry(item: ToolbarItem): CanvasMenuEntry {
  if (item.pressed !== undefined) {
    return { kind: 'toggle', id: item.id, label: item.menuLabel, checked: item.pressed, onToggle: item.run }
  }
  return {
    kind: 'action', id: item.id, label: item.menuLabel, icon: item.icon, onSelect: item.run,
    disabled: item.disabled === true || item.busy === true, busy: item.busy, note: item.menuNote,
  }
}

/** The menu bar's Review menu: the AI flows, as the toolbar offers them (empty for whoever may not run them). */
export function reviewMenuEntries(review: ReviewActions | null, t: TFunction<'projectDetail'>): CanvasMenuEntry[] {
  return reviewItems(review, t).map(overflowEntry)
}
