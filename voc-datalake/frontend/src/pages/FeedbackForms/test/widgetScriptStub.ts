/**
 * @fileoverview A stand-in for `preview/widgetScript` in the preview specs (the real widget script never runs in
 * jsdom): `vi.mock('../preview/widgetScript', () => import('../test/widgetScriptStub'))`. The widget "loads" at once,
 * and `startPreview` records its call on `widget.startPreview` and answers `widget.handle`, whose methods are spies.
 * A spec imports `widget` from here to read them (the mock is this same module).
 *
 * @module pages/FeedbackForms/test/widgetScriptStub
 */
import { vi } from 'vitest'

export const widget = {
  handle: { update: vi.fn(), goTo: vi.fn(), restart: vi.fn(), setLanguage: vi.fn(), setScheme: vi.fn(), destroy: vi.fn() },
  startPreview: vi.fn(),
}

export const loadWidget = () => Promise.resolve({ init: vi.fn() })

export function startPreview(...args: unknown[]) {
  widget.startPreview(...args)
  return widget.handle
}
