/**
 * @fileoverview The review panel beside a prototype: every tester pin, its thread,
 * resolve / reopen, and the markers drawn inside the frame (project editors only —
 * the routes refuse anyone else). Mounted on demand, so the pins are fetched only
 * when someone opens it.
 * @module components/PrototypePins/PrototypePinsPanel
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { prototypePinsApi, prototypePinsQueryKey } from '../../api/prototypePinsApi'
import { hideMessage, postToFrame, showMessage } from './pinMessages'
import PinCard from './PinCard'

interface PrototypePinsPanelProps {
  readonly projectId: string
  readonly documentId: string
  readonly frameRef: RefObject<HTMLIFrameElement | null>
  readonly showMarkers: boolean
  readonly onShowMarkersChange: (show: boolean) => void
  /** Changes when a tester stored a pin: refetch. */
  readonly refreshToken: number
  /** Changes when the frame (re)loaded: the markers must be sent again. */
  readonly frameEpoch: number
}

function usePinMutations(projectId: string, documentId: string) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: prototypePinsQueryKey(projectId, documentId) })
  const reply = useMutation({
    mutationFn: ({ pinId, text }: { pinId: string; text: string }) =>
      prototypePinsApi.reply(projectId, documentId, pinId, text),
    onSuccess: refresh,
  })
  const status = useMutation({
    mutationFn: ({ pinId, action }: { pinId: string; action: 'resolve' | 'reopen' }) =>
      prototypePinsApi.setStatus(projectId, documentId, pinId, action),
    onSuccess: refresh,
  })
  return { reply, status, busy: reply.isPending || status.isPending, failed: reply.isError || status.isError }
}

export default function PrototypePinsPanel({
  projectId, documentId, frameRef, showMarkers, onShowMarkersChange, refreshToken, frameEpoch,
}: PrototypePinsPanelProps) {
  const { t } = useTranslation('projectDetail')
  const pinsQuery = useQuery({
    queryKey: [...prototypePinsQueryKey(projectId, documentId), refreshToken],
    queryFn: () => prototypePinsApi.list(projectId, documentId),
  })
  const pins = pinsQuery.data
  const { reply, status, busy, failed } = usePinMutations(projectId, documentId)

  useEffect(() => {
    postToFrame(frameRef.current, showMarkers && pins ? showMessage(pins) : hideMessage())
  }, [frameRef, showMarkers, pins, frameEpoch])
  // Closing the panel takes its markers with it.
  useEffect(() => () => postToFrame(frameRef.current, hideMessage()), [frameRef])

  return (
    <aside className="w-80 flex-shrink-0 overflow-y-auto space-y-2" aria-label={t('prototypePins.heading')}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('prototypePins.heading')} ({pins?.length ?? 0})</h3>
        <p className="text-xs text-muted">{t('prototypePins.hint')}</p>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showMarkers} onChange={(e) => onShowMarkersChange(e.target.checked)} />
          {t('prototypePins.showOnPrototype')}
        </label>
      </div>
      {pinsQuery.isError ? <p className="text-xs text-danger">{t('prototypePins.loadFailed')}</p> : null}
      {failed ? (
        <p role="alert" className="text-xs text-danger inline-flex items-center gap-1">
          <AlertCircle size={12} /> {t('prototypePins.actionFailed')}
        </p>
      ) : null}
      {pins?.length === 0 ? <p className="text-xs text-muted">{t('prototypePins.empty')}</p> : null}
      <ul className="space-y-2">
        {(pins ?? []).map((pin, index) => (
          <PinCard
            key={pin.pin_id}
            pin={pin}
            number={index + 1}
            busy={busy}
            onReply={(text) => reply.mutateAsync({ pinId: pin.pin_id, text })}
            onStatus={(action) => status.mutate({ pinId: pin.pin_id, action })}
          />
        ))}
      </ul>
    </aside>
  )
}
