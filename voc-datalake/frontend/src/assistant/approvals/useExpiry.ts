/**
 * @fileoverview Countdown to an interrupt's `expiresAt`, re-rendering once a
 * second while time remains and stopping once it has passed.
 *
 * A missing or unparsable `expiresAt` means "never expires" here: the server
 * still enforces its TTL on resume, so the card only loses the countdown.
 *
 * @module assistant/approvals/useExpiry
 */
import { useEffect, useState } from 'react'

const TICK_MS = 1000

export interface Expiry {
  expired: boolean
  /** Milliseconds left, or null when the interrupt carries no usable expiry. */
  remainingMs: number | null
}

export function parseExpiry(expiresAt: string | undefined): number | null {
  if (expiresAt === undefined) return null
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) ? null : at
}

export function expiryAt(deadline: number | null, now: number): Expiry {
  if (deadline === null) return { expired: false, remainingMs: null }
  const remainingMs = Math.max(0, deadline - now)
  return { expired: remainingMs === 0, remainingMs }
}

/** `m:ss` (or `h:mm:ss` past an hour). */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

export function useExpiry(expiresAt: string | undefined): Expiry {
  const deadline = parseExpiry(expiresAt)
  const [now, setNow] = useState(() => Date.now())
  const done = deadline === null || now >= deadline

  useEffect(() => {
    if (done) return undefined
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [done])

  return expiryAt(deadline, now)
}
