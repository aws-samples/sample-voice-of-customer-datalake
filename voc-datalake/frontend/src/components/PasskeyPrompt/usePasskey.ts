/**
 * @fileoverview The passkey offer after sign-in and the "add a passkey" action (services/passkeyAuth.ts).
 *
 * The offer is asked once per person and browser: "Add a passkey" or "Not now" both record an answer
 * in localStorage (`voc-passkey-offer:<sub>`), and a person who already has a passkey is never asked.
 * @module components/PasskeyPrompt/usePasskey
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { canUsePasskeys, passkeyAuth } from '../../services/passkeyAuth'
import { useAuthStore } from '../../store/authStore'

const OFFER_KEY_PREFIX = 'voc-passkey-offer:'

/** The query key of "does the signed-in person have a passkey". */
export const passkeyQueryKey = (sub: string) => ['passkey', 'has', sub] as const

function offerKey(sub: string): string {
  return `${OFFER_KEY_PREFIX}${sub}`
}

function answered(sub: string): boolean {
  try {
    return window.localStorage.getItem(offerKey(sub)) !== null
  } catch {
    // Storage blocked: never nag on every page load.
    return true
  }
}

function recordAnswer(sub: string, answer: 'added' | 'declined'): void {
  try {
    window.localStorage.setItem(offerKey(sub), answer)
  } catch {
    // Storage blocked: the offer simply returns next session.
  }
}

/** Registers a passkey for the signed-in person; on success the "has a passkey" answer is refreshed. */
export function useRegisterPasskey() {
  const sub = useAuthStore((state) => state.user?.sub)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => passkeyAuth.register(),
    onSuccess: () => {
      if (sub === undefined) return
      recordAnswer(sub, 'added')
      void queryClient.invalidateQueries({ queryKey: passkeyQueryKey(sub) })
    },
  })
}

/** Whether to show the offer now, and how to decline it. */
export function usePasskeyOffer(): { readonly show: boolean; readonly decline: () => void } {
  const sub = useAuthStore((state) => state.user?.sub)
  const [declined, setDeclined] = useState(false)
  const eligible = sub !== undefined && !declined && canUsePasskeys() && !answered(sub)
  const { data: hasPasskey } = useQuery({
    queryKey: passkeyQueryKey(sub ?? ''),
    queryFn: () => passkeyAuth.hasPasskey(),
    enabled: eligible,
    staleTime: Infinity,
    retry: false,
  })
  return {
    show: eligible && hasPasskey === false,
    decline: () => {
      if (sub !== undefined) recordAnswer(sub, 'declined')
      setDeclined(true)
    },
  }
}
