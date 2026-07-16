/**
 * Guards for the Lambda asset-staging excludes (issues #194/#201/#203).
 *
 * Two failure classes are covered:
 * 1. A staging site stops excluding the noise (hash churn: staged-but-never-
 *    copied files feed CDK asset hashes — before these excludes, every
 *    deploy rolled ~25 functions with byte-identical code).
 * 2. The patterns regress to forms that leak volatile files. Issue #203:
 *    GLOB mode's 'dir/**' does not exclude dot-children (minimatch's `**`
 *    never crosses a dot segment), so cdk.out/.cache/*.zip — CDK's own
 *    publishing cache — fed each deploy's output into the next synth's
 *    ingestor fingerprints, forever. The lists are written for
 *    IgnoreMode.GIT; the behavior tests below run the REAL aws-cdk-lib
 *    IgnoreStrategy.git with the walk's ancestor-directory pruning, which
 *    is the load-bearing defense (static pattern checks can't cover every
 *    leaky form).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { IgnoreStrategy } from 'aws-cdk-lib';
import { PY_LAMBDA_ASSET_EXCLUDES, rootPluginAssetExcludes } from './lambda-asset-excludes';

const stacksDir = path.join(process.cwd(), 'lib', 'stacks');
const PLUGIN_IDS = ['app_reviews_android', 'app_reviews_ios', 's3_import', 'synthetic_reviews', 'webscraper'];

function stackSources(): Array<{ file: string; source: string }> {
  return fs.readdirSync(stacksDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: fs.readFileSync(path.join(stacksDir, file), 'utf8') }));
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
  const open = source.indexOf('{', callStart);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function forEachCallSite(needle: string, visit: (file: string, options: string) => void): void {
  for (const { file, source } of stackSources()) {
    let searchFrom = 0;
    for (;;) {
      const at = source.indexOf(needle, searchFrom);
      if (at === -1) break;
      visit(file, optionsObject(source, at + needle.length));
      searchFrom = at + 1;
    }
  }
}

/**
 * Ignore predicate exactly as CDK's staging walk evaluates it
 * (fingerprint.js/copyDirectory): each ancestor DIRECTORY is tested with
 * completelyIgnores (pruning the whole subtree when it matches), and the
 * file itself with ignores().
 */
function ignoresWith(excludes: string[]): (relativePath: string) => boolean {
  const root = '/asset-root';
  const strategy = IgnoreStrategy.git(root, excludes);
  return (relativePath) => {
    const segments = relativePath.split('/');
    for (let i = 1; i < segments.length; i++) {
      const ancestorDir = path.join(root, ...segments.slice(0, i));
      if (strategy.completelyIgnores(ancestorDir)) return true;
    }
    return strategy.ignores(path.join(root, relativePath));
  };
}

describe('asset staging sites use the shared lists in GIT ignore mode', () => {
  it("every fromAsset('lambda') spreads PY_LAMBDA_ASSET_EXCLUDES with IgnoreMode.GIT", () => {
    forEachCallSite("fromAsset('lambda'", (file, options) => {
      expect(options, `${file} stages lambda/ without PY_LAMBDA_ASSET_EXCLUDES`).toContain('...PY_LAMBDA_ASSET_EXCLUDES');
      expect(options, `${file} must pin IgnoreMode.GIT — the lists are written for gitignore semantics`).toContain('IgnoreMode.GIT');
    });
  });

  it("every root-based fromAsset('.') uses rootPluginAssetExcludes with IgnoreMode.GIT", () => {
    forEachCallSite("fromAsset('.'", (file, options) => {
      expect(options, `${file} stages the project root without the shared exclude helper`).toContain('rootPluginAssetExcludes(');
      expect(options, `${file} must pin IgnoreMode.GIT`).toContain('IgnoreMode.GIT');
    });
  });
});

describe('root staging behavior (aws-cdk-lib IgnoreStrategy.git)', () => {
  const ignores = ignoresWith(rootPluginAssetExcludes('webscraper', PLUGIN_IDS));

  it('prunes cdk.out INCLUDING its dot-children — the issue #203 churn loop', () => {
    // The exact file class that fed every deploy's hash back into the next
    // synth: CDK's own asset-publishing cache.
    expect(ignores('cdk.out/.cache/0ce2e32d12eb43f7.zip')).toBe(true);
  });

  it('prunes repo metadata and tool dirs with their dot-children', () => {
    // .git/index changes on every commit/checkout — without this the
    // ingestor hashes churn across commits with zero payload changes.
    expect(ignores('.git/index')).toBe(true);
    expect(ignores('.git/refs/heads/development')).toBe(true);
    expect(ignores('node_modules/.bin/tsc')).toBe(true);
    expect(ignores('.venv/.gitignore')).toBe(true);
    expect(ignores('.ruff_cache/.gitignore')).toBe(true);
    expect(ignores('frontend/.env.local')).toBe(true);
    expect(ignores('.env.local')).toBe(true);
  });

  it('keeps everything the plugin bundle actually copies', () => {
    expect(ignores('plugins/webscraper/ingestor/handler.py')).toBe(false);
    expect(ignores('plugins/_shared/base_ingestor.py')).toBe(false);
    expect(ignores('lambda/shared/api.py')).toBe(false);
  });

  it('top-level tool-dir names do NOT swallow payload subtrees of the same name', () => {
    // The anchored '/lib/', '/bin/', '/scripts/', '/dist/' entries must not
    // exclude a plugin's own helper folders — a silent payload drop.
    expect(ignores('plugins/webscraper/ingestor/lib/parser.py')).toBe(false);
    expect(ignores('plugins/webscraper/ingestor/scripts/seed.py')).toBe(false);
    expect(ignores('lambda/shared/bin/helper.py')).toBe(false);
    // ...while the top-level dirs themselves stay excluded.
    expect(ignores('lib/stacks/core-stack.ts')).toBe(true);
    expect(ignores('scripts/build-layers.sh')).toBe(true);
  });

  it("sibling plugins never churn this plugin's hash; its own tree counts", () => {
    expect(ignores('plugins/s3_import/ingestor/handler.py')).toBe(true);
    expect(ignores('plugins/synthetic_reviews/ingestor/handler.py')).toBe(true);
    expect(ignores('plugins/webscraper/ingestor/scraper.py')).toBe(false);
  });

  it('still drops tests, caches, and non-payload file types anywhere', () => {
    expect(ignores('plugins/_shared/test/test_base_ingestor.py')).toBe(true);
    expect(ignores('lambda/shared/test/test_api.py')).toBe(true);
    expect(ignores('plugins/webscraper/ingestor/__pycache__/handler.cpython-314.pyc')).toBe(true);
    // NOT staged: manifest.json is a synth-time input which plugin-loader
    // reads from the SOURCE tree; the bundle command never copies it, so
    // keeping it out of the hash is correct (edits to manifests alone must
    // not redeploy ingestor code).
    expect(ignores('plugins/webscraper/manifest.json')).toBe(true);
  });
});

describe('lambda staging behavior (aws-cdk-lib IgnoreStrategy.git)', () => {
  const ignores = ignoresWith(PY_LAMBDA_ASSET_EXCLUDES);

  it('prunes layer build output and the stream package, dot-children included', () => {
    expect(ignores('layers/processing-deps/python/pydantic/main.py')).toBe(true);
    expect(ignores('stream/node_modules/.bin/vitest')).toBe(true);
    expect(ignores('stream/.env')).toBe(true);
  });

  it('keeps handler payloads — including the prompt JSONs the bundles ship', () => {
    expect(ignores('shared/api.py')).toBe(false);
    expect(ignores('api/metrics_handler.py')).toBe(false);
    // Regression guard: prompt files MUST stay in the hash, or edits to
    // them would deploy stale bundles.
    expect(ignores('api/prompts/prd-generation.json')).toBe(false);
  });

  it('drops tests at any depth', () => {
    expect(ignores('shared/test/test_api.py')).toBe(true);
    expect(ignores('jobs/document_generator/test/test_handler.py')).toBe(true);
    expect(ignores('api/test/conftest.py')).toBe(true);
  });
});
