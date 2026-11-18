/**
 * The SPA reads the modules it shares with the assistant stream Lambda (the AG-UI contract, the plan schema,
 * the approval-card bounds) from the stream package itself, `voc-datalake/lambda/stream/src`, through the
 * `@stream/*` alias, instead of keeping a mirrored copy. vite.config.ts and vitest.config.ts both apply this,
 * and tsconfig.app.json carries the same `@stream/*` path.
 *
 * `dedupe: ['zod']`: a stream module's `import 'zod'` would otherwise resolve from the stream's own
 * node_modules and bundle a second zod (+86 KB, +24 KB gzip). Both packages pin the same zod version.
 * `fsAllow`: the dev server serves only allowed folders, and the stream sources are outside the SPA root; so is the one
 * file the SPA imports from outside the frontend, the default engineering flows (`templates/orchestration/bundle.json`, read by
 * `src/api/engineeringTemplates.ts`), allowed alone, not its folder.
 * What the shared modules may import is enforced on the stream side (its eslint `browser-safe` block).
 */
import { fileURLToPath } from 'node:url'

export const STREAM_SRC = fileURLToPath(new URL('../lambda/stream/src', import.meta.url))

export const streamResolve = {
  alias: { '@stream': STREAM_SRC },
  dedupe: ['zod'],
}

const ENGINEERING_TEMPLATES_FILE = fileURLToPath(new URL('../templates/orchestration/bundle.json', import.meta.url))

/**
 * The public feedback widget's folder (it holds `feedback-widget.js` alone): the forms builder's preview loads that very
 * file (pages/FeedbackForms/preview/widgetScript.ts, a `?url` import). The folder, not the file: Vite checks an asset
 * import's id with its query (`…/feedback-widget.js?url`), which only a folder entry allows.
 */
const FEEDBACK_WIDGET_DIR = fileURLToPath(new URL('../lambda/api/static', import.meta.url))

export const streamFsAllow = ['.', STREAM_SRC, ENGINEERING_TEMPLATES_FILE, FEEDBACK_WIDGET_DIR]
