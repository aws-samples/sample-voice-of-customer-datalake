/**
 * @fileoverview A canvas's state (useCanvasDocument) for specs of what renders it: clean and
 * editable, every callback a spy; pass what the spec changes.
 */
import { createRef } from 'react'
import { vi } from 'vitest'
import type { CanvasDocument } from './useCanvasDocument'
import type { CanvasEditorHandle } from '../editor/CanvasEditor'

export function canvasState(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    content: '', title: '', setTitle: vi.fn(), onChange: vi.fn(), dirty: false, saving: false,
    save: vi.fn(() => Promise.resolve()), discard: vi.fn(), conflict: null, titleEditable: false,
    handleRef: createRef<CanvasEditorHandle | null>(), editable: true, selectDoc: vi.fn(), reloadLatest: vi.fn(),
    guardDialog: null, lastSaved: null, generation: 0, markRevised: vi.fn(), reviseRefused: null, ...overrides,
  }
}
