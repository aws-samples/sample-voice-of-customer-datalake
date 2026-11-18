/**
 * @fileoverview A canvas editor handle double for the document page's specs: every method a spy, `run` and `can`
 * answering true (a command runs and is allowed).
 *
 * @module test/canvasHandleDouble
 */
import { vi } from 'vitest'

export function canvasHandleDouble() {
  return {
    root: vi.fn(), getMarkdown: vi.fn(), setMarkdown: vi.fn(), scrollToHeading: vi.fn(), focus: vi.fn(), clearSelection: vi.fn(),
    run: vi.fn(() => true), can: vi.fn(() => true),
  }
}
