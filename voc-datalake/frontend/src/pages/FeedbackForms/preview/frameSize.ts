/**
 * @fileoverview The in-page preview's phone (PreviewFrame.tsx): 390 logical px wide, scaled down to the room there
 * is, and as tall as the room allows, up to a tall phone's 844 px:
 *
 * - `fill` (the builder's panes, as tall as the window): exactly the parent's height, so the widget's sticky Next
 *   bar and the toolbar above stay in view on a laptop (at 1280 × 800 the pane leaves about 310 logical px); never
 *   under 320 px, where the pane scrolls instead;
 * - `window` (a page that scrolls: the picker, the panel over the editor): from the frame's top to the window's
 *   bottom, at least 480 px;
 * - a number: that height.
 *
 * @module pages/FeedbackForms/preview/frameSize
 */
import { clamp } from '../../../lib/clamp'

/** The phone the preview lays out in, in logical (CSS) px. */
export const PHONE_WIDTH = 390
/** The shortest phone `window` gives. */
export const MIN_HEIGHT = 480
/** The shortest phone `fill` gives (a phone on its side is 390): below it the pane scrolls. */
export const SHORT_HEIGHT = 320
const MAX_HEIGHT = 844
/** What `fit="window"` leaves under the frame: the page's own bottom padding and a line of notes. */
const WINDOW_GAP_PX = 104

/** The phone's logical size and the scale it is drawn at (the pane's "Phone · 390 × 610 · 90 %"). */
export interface FrameSize {
  readonly width: number
  readonly height: number
  readonly scale: number
}

/** The room the frame's box has, and where it starts in a window this tall. */
export interface Room {
  readonly width: number
  readonly height: number
  readonly top: number
  readonly windowHeight: number
}

/** The phone's logical size and scale in `room` (a box not laid out yet draws at full size). */
export function frameSize(room: Room, fit: 'window' | 'fill' | number): FrameSize {
  const scale = room.width > 0 ? Math.min(1, room.width / PHONE_WIDTH) : 1
  if (typeof fit === 'number') return { width: PHONE_WIDTH, height: fit, scale }
  if (fit === 'fill') return { width: PHONE_WIDTH, height: clamp(Math.floor(room.height / scale), SHORT_HEIGHT, MAX_HEIGHT), scale }
  const space = room.windowHeight - room.top - WINDOW_GAP_PX
  return { width: PHONE_WIDTH, height: clamp(Math.floor(space / scale), MIN_HEIGHT, MAX_HEIGHT), scale }
}
