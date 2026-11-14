/**
 * @fileoverview The prototype frame with its pin feedback and its walkthrough wired up (docs/feedback-forms.md,
 * docs/prototype-builder.md Part 1).
 *
 * Every viewer gets the BRIDGE, so the widget's "Feedback" button works for anyone who can open the prototype
 * here (testers included — the submit route is public), and the version's walkthrough starts once by itself on a
 * version not yet seen (unless the series says "don't show again"), with **Show walkthrough** to replay it. Project
 * editors additionally get the review overlay on demand (the pin list beside the frame and numbered markers inside
 * it; nothing is fetched until the panel is opened) and the **Walkthrough** editor. Legacy inline prototypes have
 * no widget; a version written before 6.17.00 has no walkthrough runtime (no Show walkthrough, no picking).
 * @module components/PrototypePins/PrototypePinsReview
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks, MapPin, PlayCircle } from 'lucide-react'
import type { ProjectDocument } from '../../api/types'
import { useAuthStore } from '../../store/authStore'
import { HtmlPrototypeFrame } from '../PrototypeRenderer'
import WalkthroughEditor from '../PrototypeWalkthrough/WalkthroughEditor'
import { usePinBridge } from './usePinBridge'
import { useWalkthroughHost } from './useWalkthroughHost'
import PrototypePinsPanel from './PrototypePinsPanel'

interface PrototypePinsReviewProps {
  readonly projectId: string
  readonly documentId: string
  readonly url?: string
  readonly html?: string
  readonly title: string
  /** Project editor: may list and moderate pins, and edit the walkthrough. */
  readonly canEdit: boolean
  /** The prototype series ("don't show again" is remembered per series); '' keys it by the version alone. */
  readonly seriesKey?: string
  /** A saved walkthrough is a new version: the page selects it. Without it there is no walkthrough editor. */
  readonly onSelectDoc?: (doc: ProjectDocument) => void
}

// Below lg the panels stack under the frame in a pane that grows: the frame keeps half the viewport of its own.
const FRAME_CLASS = 'w-full h-full min-h-[50vh] lg:min-h-0 border-0 rounded-lg'

/** The row above the frame: Pins (reviewers), Show walkthrough (a version with steps), Walkthrough (editors). */
function ReviewToolbar({ reviewable, panelOpen, onPins, steps, onShow, editable, editorOpen, onEditor }: Readonly<{
  reviewable: boolean; panelOpen: boolean; onPins: () => void; steps: number; onShow: () => void
  editable: boolean; editorOpen: boolean; onEditor: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const { t: tc } = useTranslation('components')
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {reviewable ? (
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={panelOpen} onClick={onPins}>
          <MapPin size={12} /> {t('prototypePins.toggle')}
        </button>
      ) : null}
      {steps > 0 ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onShow}>
          <PlayCircle size={12} aria-hidden /> {tc('prototypeWalkthrough.show')}
        </button>
      ) : null}
      {editable ? (
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={editorOpen} onClick={onEditor}>
          <ListChecks size={12} aria-hidden /> {tc('prototypeWalkthrough.open')}
        </button>
      ) : null}
    </div>
  )
}

export default function PrototypePinsReview({
  projectId, documentId, url, html, title, canEdit, seriesKey = '', onSelectDoc,
}: PrototypePinsReviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [showMarkers, setShowMarkers] = useState(false)
  // Bumped when a tester's pin is stored (refetch) and when the frame (re)loads (re-send markers).
  const [refreshToken, setRefreshToken] = useState(0)
  const [frameEpoch, setFrameEpoch] = useState(0)
  const reviewable = canEdit && Boolean(url)
  const person = useAuthStore((state) => state.user?.sub ?? '')
  const walkthrough = useWalkthroughHost({ person, projectId, seriesKey: seriesKey === '' ? documentId : seriesKey, documentId })

  const widgetPort = usePinBridge(frameRef, {
    onReady: (review) => {
      if (review && reviewable) {
        setPanelOpen(true)
        setShowMarkers(true)
      }
      setFrameEpoch((epoch) => epoch + 1)
    },
    onSubmitted: () => setRefreshToken((token) => token + 1),
    onWalkthrough: walkthrough.onMessage,
  })

  const frame = (
    <div className="flex-1 overflow-hidden border rounded-lg bg-card min-w-0">
      <HtmlPrototypeFrame frameRef={frameRef} url={url} html={html} title={title} className={FRAME_CLASS} />
    </div>
  )
  // The walkthrough editor needs the page's selection of the version a save writes.
  const editorSave = canEdit ? onSelectDoc : undefined
  // One tree whatever the toolbar shows: the frame never moves, so a walkthrough arriving does not reload it.
  const toolbar = reviewable || editorSave !== undefined || walkthrough.steps > 0

  return (
    <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
      {toolbar ? (
        <ReviewToolbar reviewable={reviewable} panelOpen={panelOpen} onPins={() => setPanelOpen((open) => !open)}
          steps={walkthrough.steps} onShow={walkthrough.show}
          editable={editorSave !== undefined} editorOpen={editorOpen} onEditor={() => setEditorOpen((open) => !open)} />
      ) : null}
      <div className="flex-1 overflow-hidden flex flex-col lg:flex-row gap-3 min-h-0">
        {frame}
        {reviewable && panelOpen ? (
          <PrototypePinsPanel projectId={projectId} documentId={documentId} widgetPortRef={widgetPort}
            showMarkers={showMarkers} onShowMarkersChange={setShowMarkers}
            refreshToken={refreshToken} frameEpoch={frameEpoch} />
        ) : null}
        {editorSave !== undefined && editorOpen ? (
          <WalkthroughEditor key={documentId} projectId={projectId} documentId={documentId} host={walkthrough}
            onSaved={editorSave} onClose={() => setEditorOpen(false)} />
        ) : null}
      </div>
    </div>
  )
}
