/** On-screen box arithmetic for the assistant launcher checks (assistant-bubble.spec.ts). */
import { expect, type Locator } from '@playwright/test'

export interface Box { x: number; y: number; width: number; height: number }

export const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** How far `to` sits up and left of `from`, in whole pixels (sub-pixel layout rounded). */
export function travelFrom(from: Box, to: Box): { up: number; left: number } {
  // `+ 0` folds -0 into 0, so a reset compares equal to { up: 0, left: 0 }.
  return { up: Math.round(from.y - to.y) + 0, left: Math.round(from.x - to.x) + 0 }
}

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('element has no box (not visible)')
  return box
}

/**
 * Waits until `locator` has travelled exactly `expected` from `from`. QA 3.00.00 S5:
 * the launcher eases right/bottom over 150 ms (`motion-safe:transition-[right,bottom…]`),
 * so a single read right after the key press saw it (nearly) where it started. Polling
 * for the FINAL value waits out the transition, however long it is, with no fixed sleep.
 */
/**
 * The launcher's box once it has stopped moving: two reads `gapMs` apart (longer than
 * its 150 ms ease) that agree to the pixel. F5-b's pages move the launcher clear of a
 * sticky bar after load and after the bottom scroll; one read taken mid-ease judged a
 * box the launcher was only passing through. Same principle as `expectTravel`, for
 * when the final position is not known up front.
 */
export async function settledBoxOf(locator: Locator, gapMs = 200): Promise<Box> {
  let settled: Box | undefined
  await expect.poll(async () => {
    const first = await boxOf(locator)
    await locator.page().waitForTimeout(gapMs)
    const second = await boxOf(locator)
    const still = travelFrom(first, second)
    if (still.up !== 0 || still.left !== 0) return false
    settled = second
    return true
  }, { message: 'launcher stops moving' }).toBe(true)
  if (settled === undefined) throw new Error('launcher never settled')
  return settled
}

export async function expectTravel(locator: Locator, from: Box, expected: { up: number; left: number }, message: string): Promise<void> {
  await expect.poll(async () => travelFrom(from, await boxOf(locator)), { message }).toEqual(expected)
}
