/**
 * @fileoverview A voice session's end as the projects API records it (`POST …/voice-sessions/{sid}/end`, which stops
 * the relay if it still runs and files the transcript; docs/voice-personas.md), outside React like the connection:
 *
 * - `record` posts it once the session is over, retried `END_ATTEMPTS` times (a dropped request, a busy API), and
 *   again when the person presses Try again after every attempt failed;
 * - `pageHidden` (the page's `pagehide`: a closed tab, a reload, a navigation away) posts it once more with
 *   `keepalive`, so the request outlives the page, but only once the connection is over and while the end is not
 *   recorded. A session still live is left to the relay: the page's going closes its WebSocket, and the relay
 *   finishes on its own (the last turns, the meter, the row marked ended), which an End posted now could cut short
 *   (the projects API's End stops the runtime). The projects API's next offer of the project's personas then saves a
 *   session whose End never arrived.
 *
 * @module pages/ProjectDetail/voice/voiceSessionEnd
 */

/** Whether the end was recorded: not yet asked, being posted, recorded, or every attempt failed. */
export type EndState = 'no' | 'posting' | 'yes' | 'failed'

export interface EndRecorder {
  readonly record: () => void
  readonly pageHidden: () => void
}

const END_ATTEMPTS = 3
/** The wait before the second attempt; each later one waits that much longer. */
const END_RETRY_MS = 2000

async function postWithRetries(post: () => Promise<unknown>, attempt = 1): Promise<boolean> {
  try {
    await post()
    return true
  } catch (error: unknown) {
    console.warn('Voice session: the end could not be recorded', error)
    if (attempt >= END_ATTEMPTS) return false
    await new Promise((resolve) => { globalThis.setTimeout(resolve, END_RETRY_MS * attempt) })
    return postWithRetries(post, attempt + 1)
  }
}

/** The recorder of one session's End: the request (with keepalive or not), and who hears each change of its state.
 * `record` is called once the connection is over (and on Try again), so before it the session is live. */
export function createEndRecorder(post: (keepalive: boolean) => Promise<unknown>, onState: (state: EndState) => void): EndRecorder {
  const held = { over: false, recorded: false, posting: false }
  return {
    record: () => {
      held.over = true
      if (held.recorded || held.posting) return
      held.posting = true
      onState('posting')
      void postWithRetries(() => post(false)).then((recorded) => {
        held.recorded = recorded
        held.posting = false
        onState(recorded ? 'yes' : 'failed')
      })
    },
    pageHidden: () => {
      if (!held.over || held.recorded) return
      post(true).catch((error: unknown) => { console.warn('Voice session: the end could not be sent as the page closed', error) })
    },
  }
}
