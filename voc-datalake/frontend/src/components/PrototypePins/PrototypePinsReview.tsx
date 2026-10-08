/**
 * @fileoverview The prototype frame with its pin feedback wired up (todofeatures §6.2).
 *
 * Every viewer of a CDN prototype gets the BRIDGE, so the widget's "Feedback"
 * button works for anyone who can open the prototype here (testers included —
 * the submit route is public). Project editors additionally get the review
 * overlay on demand: the pin list beside the frame and numbered markers inside
 * it. Nothing is fetched until the panel is opened. Legacy inline prototypes
 * have no widget and render as before.
 * @module components/PrototypePins/PrototypePinsReview
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MapPin } from 'lucide-react'
import { HtmlPrototypeFrame } from '../PrototypeRenderer'
import { usePinBridge } from './usePinBridge'
import PrototypePinsPanel from './PrototypePinsPanel'

interface PrototypePinsReviewProps {
  readonly projectId: string
  readonly documentId: string
  readonly url?: string
  readonly html?: string
  readonly title: string
  /** Project editor: may list and moderate pins. */
  readonly canEdit: boolean
}

const FRAME_CLASS = 'w-full h-full border-0 rounded-lg'

export default function PrototypePinsReview({ projectId, documentId, url, html, title, canEdit }: PrototypePinsReviewProps) {
  const { t } = useTranslation('projectDetail')
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [showMarkers, setShowMarkers] = useState(false)
  // Bumped when a tester's pin is stored (refetch) and when the frame (re)loads (re-send markers).
  const [refreshToken, setRefreshToken] = useState(0)
  const [frameEpoch, setFrameEpoch] = useState(0)
  const reviewable = canEdit && Boolean(url)

  usePinBridge(frameRef, {
    onReady: (review) => {
      if (review && reviewable) {
        setPanelOpen(true)
        setShowMarkers(true)
      }
      setFrameEpoch((epoch) => epoch + 1)
    },
    onSubmitted: () => setRefreshToken((token) => token + 1),
  })

  const frame = (
    <div className="flex-1 overflow-hidden border rounded-lg bg-card min-w-0">
      <HtmlPrototypeFrame frameRef={frameRef} url={url} html={html} title={title} className={FRAME_CLASS} />
    </div>
  )
  if (!reviewable) return frame

  return (
    <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" className="btn btn-secondary btn-sm" aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}>
          <MapPin size={12} /> {t('prototypePins.toggle')}
        </button>
      </div>
      <div className="flex-1 overflow-hidden flex gap-3 min-h-0">
        {frame}
        {panelOpen ? (
          <PrototypePinsPanel projectId={projectId} documentId={documentId} frameRef={frameRef}
            showMarkers={showMarkers} onShowMarkersChange={setShowMarkers}
            refreshToken={refreshToken} frameEpoch={frameEpoch} />
        ) : null}
      </div>
    </div>
  )
}
