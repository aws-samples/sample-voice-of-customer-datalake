/**
 * The dev server serves only the folders and files in `server.fs.allow` (streamSource.ts `streamFsAllow`); a module
 * the SPA imports from outside the frontend and the stream sources fails to load in `npm run dev` alone (vitest and
 * `vite build` never check it). The one Lambda file the SPA imports, the default engineering flows, is allowed by
 * itself, never its whole folder. Read as text: streamSource.ts is the dev server's config, not the SPA's code.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = readFileSync(join(FRONTEND, 'streamSource.ts'), 'utf8')
const RELATIVE = '../lambda/shared/engineering_flow_templates.json'

describe("the dev server's allow list", () => {
  it('names the default engineering flows the SPA imports, and the file is there', () => {
    expect(SOURCE).toContain(`const ENGINEERING_TEMPLATES_FILE = fileURLToPath(new URL('${RELATIVE}', import.meta.url))`)
    expect(existsSync(join(FRONTEND, RELATIVE))).toBe(true)
  })

  it('allows the SPA root, the stream sources and that one file, nothing else of the Lambda tree', () => {
    expect(SOURCE).toContain("export const streamFsAllow = ['.', STREAM_SRC, ENGINEERING_TEMPLATES_FILE]")
  })

  it('is where the SPA imports the file from', () => {
    expect(readFileSync(join(FRONTEND, 'src', 'api', 'engineeringTemplates.ts'), 'utf8'))
      .toContain(`from '../../${RELATIVE}'`)
  })
})
