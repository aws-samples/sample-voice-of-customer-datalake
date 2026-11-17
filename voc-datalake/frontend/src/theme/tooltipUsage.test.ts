/**
 * Rule 16 (docs/kiro-design-system.md › Tooltips): no native `title` on a DOM element (an iframe's title is its
 * accessible name and stays) nor on Link / NavLink. A native title waits for the browser's 1–2 s delay and never
 * shows on keyboard focus or touch; the app's <Tooltip> shows in 80 ms and on focus.
 *
 * The migration is a ratchet. `scripts/audit/allowlists/native_title.json` lists, per file, the titles still
 * waiting for the release that rewrites that file (253 in 154 files before 7.51.01). This fails when a file has
 * more than its entry allows, when a file that is not listed has one, and when a count fell without its entry
 * falling too, so the list only ever shrinks. The lint rule (eslint.config.js) skips exactly the listed files.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const SRC = resolve(__dirname, '..')
const FRONTEND = resolve(SRC, '..')
const REPO = resolve(FRONTEND, '../..')
const PREFIX = 'voc-datalake/frontend/src/'

const ALLOWLIST = z.object({
  entries: z.array(z.object({ key: z.string().startsWith(PREFIX), count: z.number().int().positive(), reason: z.string().min(1) })),
}).parse(JSON.parse(readFileSync(join(REPO, 'scripts/audit/allowlists/native_title.json'), 'utf8')))

/** The paths whose titles wait for a release that rewrites them (7.54 settings; the canvas and the document editor). */
const WAITING = [
  /^pages\/Settings\//, /^components\/UserAdmin\//, /^pages\/Account\//, /^pages\/WorkspaceSettings\//,
  /^components\/WorkflowEditor\//, /^components\/DocumentCanvas\//,
]

/** Every production .tsx under src (specs and test support excluded). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path)
    return name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/u.test(name) ? [path] : []
  })
}

const isTitled = (tag: string) => (/^[a-z]/u.test(tag) && tag !== 'iframe') || tag === 'Link' || tag === 'NavLink'

/** How many native `title` attributes the TSX `code` puts on DOM elements and Link / NavLink. */
function nativeTitles(code: string): number {
  const source = ts.createSourceFile('file.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const count = (node: ts.Node): number => {
    const own = (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isTitled(node.tagName.getText(source))
      ? node.attributes.properties.filter((a) => ts.isJsxAttribute(a) && a.name.getText(source) === 'title').length
      : 0
    return own + node.getChildren(source).reduce((sum, child) => sum + count(child), 0)
  }
  return count(source)
}

const counts = new Map(sourceFiles(SRC)
  .map((path) => [relative(SRC, path).split('\\').join('/'), nativeTitles(readFileSync(path, 'utf8'))] as const)
  .filter(([, n]) => n > 0))
const allowed = new Map(ALLOWLIST.entries.map((entry) => [entry.key.slice(PREFIX.length), entry.count]))

describe('nativeTitles', () => {
  it('counts a title on a DOM element and on Link / NavLink, not on an iframe, an SVG <title> or a component prop', () => {
    const code = `export const A = () => (<div>
      <button title="a">x</button><span title={b} />
      <Link to="/" title="c">y</Link><NavLink to="/" title="d">z</NavLink>
      <iframe title="kept" /><svg><title>kept</title></svg><ConfirmModal title="kept" /><Tooltip content="t"><b /></Tooltip>
    </div>)`
    expect(nativeTitles(code)).toBe(4)
  })

  it('scans the app (the walk itself works)', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(500)
  })
})

describe('the native-title ratchet (native_title.json)', () => {
  it('lets no file gain a native title', () => {
    const grown = [...counts].filter(([file, n]) => n > (allowed.get(file) ?? 0)).map(([file, n]) => `${file}: ${String(n)}`)
    expect(grown).toStrictEqual([])
  })

  it('lowers an entry when its count falls, and deletes it at zero', () => {
    const stale = [...allowed].filter(([file, n]) => (counts.get(file) ?? 0) < n)
      .map(([file, n]) => `${file}: listed ${String(n)}, found ${String(counts.get(file) ?? 0)}`)
    expect(stale).toStrictEqual([])
  })

  it('lists only the paths that wait for the release that rewrites them', () => {
    expect([...allowed.keys()].filter((file) => !WAITING.some((path) => path.test(file)))).toStrictEqual([])
  })

  it('is what the lint rule skips', () => {
    const config = readFileSync(join(FRONTEND, 'eslint.config.js'), 'utf8')
    expect(config).toContain("from '../../scripts/audit/allowlists/native_title.json'")
    expect(config).toContain("JSXOpeningElement[name.name=/^(?!iframe$)[a-z]/] > JSXAttribute[name.name='title']")
  })
})
