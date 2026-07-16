/**
 * Guards for the Lambda asset-staging excludes (issues #194/#201/#203).
 *
 * Two failure classes are covered:
 * 1. A staging site stops excluding the noise (hash churn: staged-but-never-
 *    copied files feed CDK asset hashes — before these excludes, every
 *    deploy rolled ~25 functions with byte-identical code).
 * 2. The patterns regress to forms that leak DOT-CHILDREN (issue #203):
 *    CDK matches with minimatch { matchBase: true }, and `**` never crosses
 *    a dot segment — 'cdk.out/**' left cdk.out/.cache/*.zip (CDK's own
 *    publishing cache) in the fingerprint, so every deploy changed the next
 *    synth's ingestor hashes forever. The behavior tests below run the
 *    REAL aws-cdk-lib IgnoreStrategy against the exported lists.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { IgnoreStrategy } from 'aws-cdk-lib'
import { PY_LAMBDA_ASSET_EXCLUDES, ROOT_PLUGIN_ASSET_EXCLUDES } from './lambda-asset-excludes'

const stacksDir = path.join(process.cwd(), 'lib', 'stacks')

function stackSources(): Array<{ file: string; source: string }> {
  return fs.readdirSync(stacksDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: fs.readFileSync(path.join(stacksDir, file), 'utf8') }))
}

/**
 * The full `fromAsset(...)` options argument: from the first `{` after the
 * call start to its balanced closing brace. Exact rather than a fixed-width
 * window, so refactors inside the options object can't slide the assertion
 * off target. The only braces inside these call sites' string literals are
 * balanced `${...}` interpolations, which cancel out in the depth count; an
 * unbalanced brace would end the slice early and fail the containment
 * assertions loudly.
 */
function optionsObject(source: string, callStart: number): string {
  const open = source.indexOf('{', callStart)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

function forEachCallSite(needle: string, visit: (file: string, options: string) => void): void {
  for (const { file, source } of stackSources()) {
    let searchFrom = 0
    for (;;) {
      const at = source.indexOf(needle, searchFrom)
      if (at === -1) break
      visit(file, optionsObject(source, at + needle.length))
      searchFrom = at + 1
    }
  }
}

/**
 * Ignore predicate exactly as CDK's staging walk evaluates it
 * (fingerprint.js/copyDirectory): each ancestor DIRECTORY is tested with
 * completelyIgnores (pruning the whole subtree when it matches), and the
 * file itself with ignores(). Testing only the file path would miss the
 * directory pruning that makes bare-name dir patterns work.
 */
function ignoresWith(excludes: string[]): (relativePath: string) => boolean {
  const root = '/asset-root'
  const strategy = IgnoreStrategy.glob(root, excludes)
  return (relativePath) => {
    const segments = relativePath.split('/')
    for (let i = 1; i < segments.length; i++) {
      const ancestorDir = path.join(root, ...segments.slice(0, i))
      if (strategy.completelyIgnores(ancestorDir)) return true
    }
    return strategy.ignores(path.join(root, relativePath))
  }
}

describe('asset staging sites use the shared lists', () => {
  it("every fromAsset('lambda') spreads PY_LAMBDA_ASSET_EXCLUDES", () => {
    forEachCallSite("fromAsset('lambda'", (file, options) => {
      expect(options, `${file} stages lambda/ without PY_LAMBDA_ASSET_EXCLUDES`).toContain('...PY_LAMBDA_ASSET_EXCLUDES')
    })
  })

  it("every root-based fromAsset('.') uses ROOT_PLUGIN_ASSET_EXCLUDES", () => {
    forEachCallSite("fromAsset('.'", (file, options) => {
      expect(options, `${file} stages the project root without the shared exclude list`).toContain('ROOT_PLUGIN_ASSET_EXCLUDES')
    })
  })

  it('no exclude entry uses the dot-child-leaking dir/** form', () => {
    // '**'-suffixed directory patterns do not exclude the directory's
    // dot-children (issue #203). Directories must be excluded by name.
    for (const pattern of [...PY_LAMBDA_ASSET_EXCLUDES, ...ROOT_PLUGIN_ASSET_EXCLUDES]) {
      expect(pattern, `'${pattern}' would leak dot-children`).not.toMatch(/\/\*\*$/)
    }
  })
})

describe('root staging behavior (aws-cdk-lib IgnoreStrategy)', () => {
  const ignores = ignoresWith(ROOT_PLUGIN_ASSET_EXCLUDES)

  it('prunes cdk.out INCLUDING its dot-children — the issue #203 churn loop', () => {
    expect(ignores('cdk.out')).toBe(true)
    // The exact file class that fed every deploy's hash back into the next
    // synth: CDK's own asset-publishing cache.
    expect(ignores('cdk.out/.cache/0ce2e32d12eb43f7.zip')).toBe(true)
  })

  it('prunes the other volatile dirs with their dot-children', () => {
    expect(ignores('node_modules/.bin/tsc')).toBe(true)
    expect(ignores('.venv/.gitignore')).toBe(true)
    expect(ignores('.ruff_cache/.gitignore')).toBe(true)
    expect(ignores('frontend/.env.local')).toBe(true)
  })

  it('keeps everything the plugin bundles actually copy', () => {
    expect(ignores('plugins/webscraper/ingestor/handler.py')).toBe(false)
    expect(ignores('plugins/_shared/base_ingestor.py')).toBe(false)
    expect(ignores('lambda/shared/api.py')).toBe(false)
    // Manifests are synth-time inputs (plugin-loader) — staged is fine.
    expect(ignores('plugins/webscraper/manifest.json')).toBe(true)
  })

  it('still drops tests and caches anywhere in the staged trees', () => {
    expect(ignores('plugins/_shared/test/test_base_ingestor.py')).toBe(true)
    expect(ignores('lambda/shared/test/test_api.py')).toBe(true)
    expect(ignores('plugins/webscraper/ingestor/__pycache__/handler.cpython-314.pyc')).toBe(true)
  })
})

describe('lambda staging behavior (aws-cdk-lib IgnoreStrategy)', () => {
  const ignores = ignoresWith(PY_LAMBDA_ASSET_EXCLUDES)

  it('prunes layer build output and the stream package, dot-children included', () => {
    expect(ignores('layers/processing-deps/python/pydantic/main.py')).toBe(true)
    expect(ignores('stream/node_modules/.bin/vitest')).toBe(true)
    expect(ignores('stream/.env')).toBe(true)
  })

  it('keeps handler payloads — including the prompt JSONs the bundles ship', () => {
    expect(ignores('shared/api.py')).toBe(false)
    expect(ignores('api/metrics_handler.py')).toBe(false)
    // Regression guard: prompt files MUST stay in the hash, or edits to
    // them would deploy stale bundles.
    expect(ignores('api/prompts/prd-generation.json')).toBe(false)
  })

  it('drops tests at any depth', () => {
    expect(ignores('shared/test/test_api.py')).toBe(true)
    expect(ignores('jobs/document_generator/test/test_handler.py')).toBe(true)
    expect(ignores('api/test/conftest.py')).toBe(true)
  })
})
