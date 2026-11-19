/**
 * @fileoverview A stand-in for `preview/widgetScript` in specs (the real widget script never runs in jsdom):
 * `vi.mock('../widgetScript', () => import('../../test/widgetScriptStub'))`. Each preview started is recorded on
 * `widget.startPreview`, and answered with `widget.handle`, whose commands are spies.
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
