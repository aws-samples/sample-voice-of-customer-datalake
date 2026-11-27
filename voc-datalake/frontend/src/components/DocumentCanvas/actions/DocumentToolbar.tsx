/**
 * @fileoverview The document page's toolbar, at the end of its top bar: the version picker (v1 … vN, "Latest"
 * marked; VersionPicker), History, Persona review ("Ask personas to review", or "Add personas" with nobody to ask),
 * Rewrite from comments ("Revise from comments"), the Comments panel (its badge the open threads), Contents, Full
 * width, Full screen, then Share (the review link of a PR/FAQ or PRD), the row's one prominent button. The buttons
 * are listed in toolbarItems.ts; the View menu switches the same state, the Review menu runs the same AI flows (each
 * pair two doors to one place). The AI flows show their name beside their icon; the others are icons.
 *
 * A WAI-ARIA `toolbar` (useRovingToolbar: one Tab stop, the arrow keys, Home and End; toolbarControls: every icon
 * named, with its tooltip; toggles `aria-pressed`). A viewer gets no Share and no AI flow (as the menus offer them
 * only to an editor). On a narrow screen (below `md`) History, the AI flows, Contents and Full width step into a "⋯"
 * menu, with their names, so the row stays one line beside the menus. A running AI flow is said in a polite status.
 *
 * `data-document-toolbar`: the focus view's Escape is not this row's (useFocusView).
 *
 * @module components/DocumentCanvas/actions/DocumentToolbar
 */
import { Ellipsis, Share2 } from 'lucide-react'
import { useId, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useMenuButton } from '../../ProfileMenu/useMenuButton'
import { overflowEntry, toolbarItems } from './toolbarItems'
import { ToolbarButton, ToolbarMenu, ToolbarTip } from './toolbarControls'
import { useRovingToolbar } from './useRovingToolbar'
import VersionPicker from './VersionPicker'
import type { RefObject } from 'react'
import type { TFunction } from 'i18next'
import type { RovingItem } from './useRovingToolbar'
import type { ReviewActions, ToolbarItem } from './toolbarItems'
import type { VersionChoice } from './versionChoices'
import type { CanvasViewControls, ViewToggle } from './canvasMenus'
import type { ProjectDocument } from '../../../api/types'

/** Below Tailwind's `md`: the row keeps its first items and folds the rest into "⋯". */
const NARROW_TOOLBAR = '(max-width: 767.98px)'

function subscribeToWidth(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => { /* no media queries: always wide */ }
  const query = window.matchMedia(NARROW_TOOLBAR)
  query.addEventListener('change', onChange)
  return () => { query.removeEventListener('change', onChange) }
}

function isNarrowToolbar(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_TOOLBAR).matches
}

/** The versions on the toolbar: the page's document and the older version it shows (null: its own). */
interface ToolbarVersions {
  readonly projectId: string
  readonly document: ProjectDocument
  readonly viewing: number | null
  readonly onChoose: (choice: VersionChoice) => void
}

interface DocumentToolbarProps {
  readonly view?: CanvasViewControls
  readonly openThreads?: number
  readonly focus: ViewToggle
  /** The Full screen button: the page puts focus back on it when the focus view closes. */
  readonly focusButtonRef: RefObject<HTMLButtonElement | null>
  /** The picker and History (null: a document edited elsewhere has no versions here). */
  readonly versions: ToolbarVersions | null
  readonly onHistory: () => void
  /** The AI flows, for whoever may run them on the version on screen (else null). */
  readonly review: ReviewActions | null
  /** Share (an editor of a PR/FAQ or PRD, else null): whether a review link is on, and its dialog. */
  readonly share: { readonly active: boolean; readonly onOpen: () => void } | null
}

function ShareButton({ active, rove, onOpen }: Readonly<{ active: boolean; rove: RovingItem; onOpen: () => void }>) {
  const { t } = useTranslation('projectDetail')
  const tipId = useId()
  return (
    <button type="button" {...rove} aria-haspopup="dialog" aria-label={t('documents:toolbar.share')} aria-describedby={tipId} onClick={onOpen}
      className="group relative btn btn-primary btn-sm focus-ring" data-testid="toolbar-share">
      <Share2 size={14} aria-hidden="true" />
      {t('documents:toolbar.share')}
      <ToolbarTip id={tipId}>{active ? t('components:reviewShare.openActive') : t('components:reviewShare.open')}</ToolbarTip>
    </button>
  )
}

function MoreMenu({ items, rove }: Readonly<{ items: readonly ToolbarItem[]; rove: RovingItem }>) {
  const { t } = useTranslation('projectDetail')
  const menu = useMenuButton()
  return (
    <ToolbarMenu menu={menu} rove={rove} label={t('documents:toolbar.more')} hint={t('documents:toolbar.more')}
      entries={() => items.map(overflowEntry)} face={<Ellipsis size={16} aria-hidden="true" />} />
  )
}

/** What a running AI flow says to a screen reader (empty while none runs: the next start is heard). */
function runningText(review: ReviewActions | null, t: TFunction<'projectDetail'>): string {
  if (review?.review.running === true) return t('components:documentComments.personaReviewRunning')
  return review?.rewrite?.running === true ? t('canvas.revise.running') : ''
}

export default function DocumentToolbar({
  view, openThreads, focus, focusButtonRef, versions, onHistory, review, share,
}: DocumentToolbarProps) {
  const { t } = useTranslation('projectDetail')
  const narrow = useSyncExternalStore(subscribeToWidth, isNarrowToolbar, () => false)
  const items = toolbarItems({ view, openThreads, focus, onHistory: versions === null ? null : onHistory, review }, t)
  const inline = narrow ? items.filter((item) => !item.overflows) : items
  const folded = narrow ? items.filter((item) => item.overflows) : []
  const ids = [
    ...(versions === null ? [] : ['versions']), ...inline.map((item) => item.id), ...(folded.length > 0 ? ['more'] : []),
    ...(share === null ? [] : ['share']),
  ]
  const { ref, onKeyDown, rove } = useRovingToolbar(ids)
  return (
    <>
      <div ref={ref} role="toolbar" aria-label={t('documents:toolbar.label')} aria-orientation="horizontal"
        data-document-toolbar="" data-testid="document-toolbar" onKeyDown={onKeyDown} className="flex items-center gap-0.5">
        {versions === null ? null : (
          <VersionPicker projectId={versions.projectId} document={versions.document} viewing={versions.viewing}
            rove={rove('versions')} onChoose={versions.onChoose} />
        )}
        {inline.map((item) => (
          <ToolbarButton key={item.id} rove={rove(item.id)} label={item.label} hint={item.hint} icon={item.icon}
            pressed={item.pressed} badge={item.badge} disabled={item.disabled} busy={item.busy}
            opensDialog={item.opensDialog} keyShortcuts={item.keyShortcuts} text={item.text}
            buttonRef={item.id === 'fullScreen' ? focusButtonRef : undefined} onClick={item.run} />
        ))}
        {folded.length > 0 ? <MoreMenu items={folded} rove={rove('more')} /> : null}
        {share === null ? null : <ShareButton active={share.active} rove={rove('share')} onOpen={share.onOpen} />}
      </div>
      <span role="status" className="sr-only">{runningText(review, t)}</span>
    </>
  )
}

