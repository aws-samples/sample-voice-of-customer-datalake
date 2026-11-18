/**
 * The dev server serves only the folders and files in `server.fs.allow` (streamSource.ts `streamFsAllow`); a module
 * the SPA imports from outside the frontend and the stream sources fails to load in `npm run dev` alone (vitest and
 * `vite build` never check it). The one other file the SPA imports, the default engineering flows (the orchestration bundle), is allowed by
 * itself, never its whole folder. The public feedback widget's folder (7.55.00, the forms builder's preview) is allowed
 * as a folder, because Vite checks a `?url` import's id with its query; it holds the widget alone. Read as text:
 * streamSource.ts is the dev server's config, not the SPA's code.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = readFileSync(join(FRONTEND, 'streamSource.ts'), 'utf8')
const RELATIVE = '../templates/orchestration/bundle.json'
const WIDGET_DIR = '../lambda/api/static'

describe("the dev server's allow list", () => {
  it('names the default engineering flows the SPA imports, and the file is there', () => {
    expect(SOURCE).toContain(`const ENGINEERING_TEMPLATES_FILE = fileURLToPath(new URL('${RELATIVE}', import.meta.url))`)
    expect(existsSync(join(FRONTEND, RELATIVE))).toBe(true)
  })

  it('allows the SPA root, the stream sources, that one file and the widget folder, nothing else of the Lambda tree', () => {
    expect(SOURCE).toContain("export const streamFsAllow = ['.', STREAM_SRC, ENGINEERING_TEMPLATES_FILE, FEEDBACK_WIDGET_DIR]")
  })

  it('allows a widget folder that holds the widget alone, the file the builder preview imports', () => {
    expect(SOURCE).toContain(`const FEEDBACK_WIDGET_DIR = fileURLToPath(new URL('${WIDGET_DIR}', import.meta.url))`)
    expect(readdirSync(join(FRONTEND, WIDGET_DIR))).toStrictEqual(['feedback-widget.js'])
    expect(readFileSync(join(FRONTEND, 'src', 'pages', 'FeedbackForms', 'preview', 'widgetScript.ts'), 'utf8'))
      .toContain(`import widgetUrl from '../../../../${WIDGET_DIR}/feedback-widget.js?url'`)
  })

  it('is where the SPA imports the file from', () => {
    expect(readFileSync(join(FRONTEND, 'src', 'api', 'engineeringTemplates.ts'), 'utf8'))
      .toContain(`import { flows } from '../../${RELATIVE}'`)
  })
})
