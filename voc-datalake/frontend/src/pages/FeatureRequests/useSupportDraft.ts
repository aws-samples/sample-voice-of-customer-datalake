/**
 * @fileoverview A support draft with validate-on-submit over the board's support fields: errors
 * appear once the visitor tried to send, then follow every edit.
 *
 * @module pages/FeatureRequests/useSupportDraft
 */
import { useState } from 'react'
import { validateSupport } from './boardFormat'
import type { SupportDraft, SupportErrors, SupportSpec } from './boardFormat'

export function useSupportDraft(initial: SupportDraft, spec: SupportSpec) {
  const [draft, setDraft] = useState(initial)
  const [tried, setTried] = useState(false)
  const errors: SupportErrors = tried ? validateSupport(draft, spec) : {}
  return {
    draft,
    setDraft,
    errors,
    /** Marks the draft as submitted; true when it is valid and may be sent. */
    attempt: (): boolean => {
      setTried(true)
      return Object.keys(validateSupport(draft, spec)).length === 0
    },
    reset: (next: SupportDraft) => {
      setDraft(next)
      setTried(false)
    },
  }
}
