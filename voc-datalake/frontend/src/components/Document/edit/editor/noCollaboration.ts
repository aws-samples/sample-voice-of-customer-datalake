/**
 * What the drag handle (@tiptap/extension-drag-handle) imports from @tiptap/y-tiptap and
 * @tiptap/extension-collaboration, for a canvas without real-time collaboration. The frontend's
 * `canvasResolve.ts` (beside vite.config.ts) points both packages here for the dev server, the build and the unit
 * tests (vitest.config.ts), so every run
 * uses this file: the handle only reads them when a Yjs sync plugin is installed (none is), and the real ones bundle
 * Yjs, 113 kB (35 kB gzip) the Documents tab would download for nothing.
 */
export const ySyncPluginKey = { getState: (): null => null }
export const absolutePositionToRelativePosition = (): null => null
export const relativePositionToAbsolutePosition = (): number => 0
export const isChangeOrigin = (): boolean => false
