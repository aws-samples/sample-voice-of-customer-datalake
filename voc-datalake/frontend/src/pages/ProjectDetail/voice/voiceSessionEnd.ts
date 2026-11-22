/**
 * @fileoverview A voice session's end as the projects API records it (`POST …/voice-sessions/{sid}/end`, which stops
 * the relay if it still runs and files the transcript; docs/voice-personas.md), outside React like the connection:
 *
 * - `record` posts it once the session is over, retried `END_ATTEMPTS` times (a dropped request, a busy API), and
 *   again when the person presses Try again after every attempt failed;
 * - `pageHidden` (the page's `pagehide`: a closed tab, a reload, a navigation away) posts it once more with
 *   `keepalive`, so the request outlives the page, unless it was already recorded. The projects API's next offer of
 *   the project's personas saves a session whose End never arrived at all.
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

/** The recorder of one session's End: the request (with keepalive or not), and who hears each change of its state. */
export function createEndRecorder(post: (keepalive: boolean) => Promise<unknown>, onState: (state: EndState) => void): EndRecorder {
  const held = { recorded: false, posting: false }
  return {
    record: () => {
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
      if (held.recorded) return
      post(true).catch((error: unknown) => { console.warn('Voice session: the end could not be sent as the page closed', error) })
    },
  }
}
