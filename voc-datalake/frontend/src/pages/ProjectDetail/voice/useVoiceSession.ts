/**
 * @fileoverview A live voice session for the modal (docs/voice-personas.md): its connection (voiceConnection.ts),
 * the state folded from the relay's messages (voiceSessionState.ts), the microphone's level, a clock that runs while
 * the session is live, and, once it is over, the projects API's end (`POST …/voice-sessions/{sid}/end`, which files
 * the transcript) and the session's status until the transcript document is there.
 *
 * The end is posted once, whatever ended the session (End, the relay's limit, a dropped connection, the page
 * closing), so no session is left for the person to clean up.
 *
 * @module pages/ProjectDetail/voice/useVoiceSession
 */
import { useEffect, useReducer, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RelayMessage, VoiceEndReason } from '@stream/voice/protocol'
import { voiceKeys, voiceSessionsApi } from '../../../api/voiceSessionsApi'
import type { StartedVoiceSession, VoiceSessionStatus } from '../../../api/voiceSessionsApi'
import { createVoiceConnection } from './voiceConnection'
import type { VoiceAudio } from './voiceAudio'
import { endVoice, initialVoiceState, reduceVoice } from './voiceSessionState'
import type { VoiceState } from './voiceSessionState'

const STATUS_POLL_MS = 2000
const SECOND_MS = 1000

type Action =
  | { readonly kind: 'relay'; readonly message: RelayMessage }
  | { readonly kind: 'ending' }
  | { readonly kind: 'closed'; readonly reason: VoiceEndReason }

function reducer(state: VoiceState, action: Action): VoiceState {
  if (action.kind === 'relay') return reduceVoice(state, action.message)
  if (action.kind === 'closed') return endVoice(state, action.reason)
  return state.phase === 'ended' ? state : { ...state, phase: 'ending' }
}

/** Whether the transcript is filed (or will not be). */
const settled = (status: VoiceSessionStatus | undefined): boolean => status?.status === 'finalized' || status?.status === 'failed'

/** Whole seconds since the session went live, ticking only while it is. */
function useLiveClock(live: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = globalThis.setInterval(() => { if (live) setSeconds((value) => value + 1) }, SECOND_MS)
    return () => globalThis.clearInterval(timer)
  }, [live])
  return seconds
}

export interface VoiceSessionTarget {
  readonly projectId: string
  readonly personaId: string
  readonly started: StartedVoiceSession
  readonly audio: VoiceAudio
}

export function useVoiceSession({ projectId, personaId, started, audio }: VoiceSessionTarget) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialVoiceState(started.session_minutes * 60, started.minutes_left))
  const [level, setLevel] = useState(0)
  const [posted, setPosted] = useState<'no' | 'yes' | 'failed'>('no')
  const [connection] = useState(() => createVoiceConnection(started.connect_url, audio, {
    onMessage: (message) => dispatch({ kind: 'relay', message }),
    onLevel: setLevel,
    // Called once per connection, whatever ended it (voiceConnection.ts), so the end is posted once.
    onClosed: (reason) => {
      dispatch({ kind: 'closed', reason })
      setLevel(0)
      voiceSessionsApi.end(projectId, personaId, started.session_id)
        .then(() => setPosted('yes'))
        .catch((error: unknown) => {
          console.warn('Voice session: the end could not be recorded', error)
          setPosted('failed')
        })
    },
  }))
  useEffect(() => {
    connection.connect()
    return connection.release
  }, [connection])
  const status = useQuery({
    queryKey: voiceKeys.session(started.session_id),
    queryFn: () => voiceSessionsApi.getSession(projectId, personaId, started.session_id),
    enabled: posted === 'yes',
    refetchInterval: (query) => (settled(query.state.data) ? false : STATUS_POLL_MS),
  })
  const elapsed = useLiveClock(state.phase === 'live')
  const end = () => {
    dispatch({ kind: 'ending' })
    connection.end()
  }
  return { state, level, elapsed, status: status.data, endFailed: posted === 'failed', end }
}
