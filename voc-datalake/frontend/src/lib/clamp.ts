/**
 * @fileoverview A number kept within a range: the assistant launcher inside the viewport, the forms preview's phone
 * inside the room the window leaves.
 * @module lib/clamp
 */

/** `value` kept within `min`…`max`; `min` when the range is empty (`max` < `min`: there is no room, keep the floor). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
