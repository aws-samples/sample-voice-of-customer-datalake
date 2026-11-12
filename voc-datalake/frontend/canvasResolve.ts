/**
 * The document canvas has no real-time collaboration, so the drag handle's Yjs imports (@tiptap/y-tiptap,
 * @tiptap/extension-collaboration) bind to a stand-in (src/components/DocumentCanvas/editor/noCollaboration.ts says
 * why). vite.config.ts (the dev server, the e2e previews and the build) and vitest.config.ts both apply this one
 * alias, so the unit tests, the e2e runs and the shipped bundle all run the same code.
 */
import { fileURLToPath } from 'node:url'

const NO_COLLABORATION = fileURLToPath(new URL('./src/components/DocumentCanvas/editor/noCollaboration.ts', import.meta.url))

export const canvasAlias = {
  '@tiptap/y-tiptap': NO_COLLABORATION,
  '@tiptap/extension-collaboration': NO_COLLABORATION,
}
