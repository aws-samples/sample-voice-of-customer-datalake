/**
 * @fileoverview Where each user has put the assistant launcher (E2E F5).
 *
 * Persisted to localStorage (`voc-assistant-bubble`), keyed by the signed-in
 * user, so two people sharing a browser each keep their own spot and signing
 * out does not move anyone's launcher. A position is only a UI preference — no
 * content — so unlike the assistant's UI store it is not wiped on sign-out.
 *
 * A tampered or stale record is dropped entry by entry through a lenient Zod
 * schema, never trusted: an unreadable position renders at the default corner.
 *
 * @module assistant/bubble/bubbleStore
 */
import { z } from 'zod'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAuthStore } from '../../store/authStore'
import type { BubblePosition } from './geometry'

const PositionSchema = z.object({ right: z.number(), bottom: z.number() })

interface BubbleState {
  /** Launcher position per user key (`userKey`). Absent = the default corner. */
  positions: Record<string, BubblePosition>
  setPosition: (user: string, position: BubblePosition) => void
  resetPosition: (user: string) => void
}

/** Keep only the well-formed entries of a persisted `positions` record. */
export function readPositions(value: unknown): Record<string, BubblePosition> {
  if (typeof value !== 'object' || value === null) return {}
  const positions: Record<string, BubblePosition> = {}
  for (const [user, raw] of Object.entries(value)) {
    const parsed = PositionSchema.safeParse(raw)
    if (parsed.success) positions[user] = parsed.data
  }
  return positions
}

/** `positions` without `user`'s entry (a fresh object). */
function withoutUser(positions: Record<string, BubblePosition>, user: string): Record<string, BubblePosition> {
  return Object.fromEntries(Object.entries(positions).filter(([key]) => key !== user))
}

export const useBubbleStore = create<BubbleState>()(
  persist(
    (set) => ({
      positions: {},
      setPosition: (user, position) => set((s) => ({ positions: { ...s.positions, [user]: position } })),
      resetPosition: (user) => set((s) => ({ positions: withoutUser(s.positions, user) })),
    }),
    {
      name: 'voc-assistant-bubble',
      partialize: (s) => ({ positions: s.positions }),
      merge: (persisted, current) => {
        if (typeof persisted !== 'object' || persisted === null || !('positions' in persisted)) return current
        return { ...current, positions: readPositions(persisted.positions) }
      },
    },
  ),
)

/** The key a position is stored under: the Cognito `sub`, else the username. */
export function useBubbleUserKey(): string {
  return useAuthStore((s) => s.user?.sub ?? s.user?.username ?? 'anonymous')
}
