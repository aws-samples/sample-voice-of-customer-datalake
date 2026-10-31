/**
 * @fileoverview The passkey offer after sign-in, and the Account page's passkey list with its add and
 * remove actions (services/passkeyAuth.ts).
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

/** Every passkey query of one person: whether they have one, and the list. */
const passkeyRootKey = (sub: string) => ['passkey', sub] as const

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

/** A passkey mutation that refreshes the person's passkey queries when it succeeds. */
function usePasskeyMutation<T>(run: (arg: T) => Promise<void>, onDone?: (sub: string) => void) {
  const sub = useAuthStore((state) => state.user?.sub)
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      if (sub === undefined) return
      onDone?.(sub)
      void queryClient.invalidateQueries({ queryKey: passkeyRootKey(sub) })
    },
  })
}

/** Registers a passkey for the signed-in person (and answers the offer). */
export function useRegisterPasskey() {
  return usePasskeyMutation<void>(() => passkeyAuth.register(), (sub) => recordAnswer(sub, 'added'))
}

/** Removes one of the signed-in person's passkeys. */
export function useRemovePasskey() {
  return usePasskeyMutation((id: string) => passkeyAuth.remove(id))
}

/** The signed-in person's passkeys (none read where passkeys cannot be used). */
export function usePasskeyList() {
  const sub = useAuthStore((state) => state.user?.sub)
  return useQuery({
    queryKey: [...passkeyRootKey(sub ?? ''), 'list'],
    queryFn: () => passkeyAuth.list(),
    enabled: sub !== undefined && canUsePasskeys(),
    retry: false,
  })
}

/** Whether to show the offer now, how to decline it, and how to close it once a passkey is added. */
export function usePasskeyOffer(): { readonly show: boolean; readonly decline: () => void; readonly close: () => void } {
  const sub = useAuthStore((state) => state.user?.sub)
  const [closed, setClosed] = useState(false)
  const eligible = sub !== undefined && !closed && canUsePasskeys() && !answered(sub)
  const { data: hasPasskey } = useQuery({
    queryKey: [...passkeyRootKey(sub ?? ''), 'has'],
    queryFn: () => passkeyAuth.hasPasskey(),
    enabled: eligible,
    staleTime: Infinity,
    retry: false,
  })
  return {
    show: eligible && hasPasskey === false,
    decline: () => {
      if (sub !== undefined) recordAnswer(sub, 'declined')
      setClosed(true)
    },
    // Closed at once, not when the "has a passkey" read comes back (it may be slow or fail).
    close: () => setClosed(true),
  }
}
