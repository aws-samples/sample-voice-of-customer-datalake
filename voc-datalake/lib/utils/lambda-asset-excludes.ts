/**
 * Shared staging excludes for Lambda `Code.fromAsset(...)` bundles
 * (issues #194/#201 follow-ups, #203).
 *
 * Everything staged feeds the CDK asset hash — even files the bundling
 * command never copies into /asset-output. Without these excludes, local
 * layer build output, the Node streaming Lambda's 141MB node_modules, tests
 * and caches were hashed into every Python function asset, so unrelated
 * edits redeployed all ~25 functions with byte-identical code.
 *
 * WHY IgnoreMode.GIT (issue #203 — the default GLOB mode bit us hard):
 * GLOB matches with `minimatch(relativePath, pattern, { matchBase: true })`
 * where `**` never crosses a dot segment — so 'cdk.out/**' left
 * cdk.out/.cache/*.zip (CDK's own publishing cache!) in the fingerprint,
 * and every deploy changed the next synth's ingestor hashes, forever.
 * GLOB also cannot express "top-level only" for a bare name (matchBase
 * makes 'lib' match plugins/x/ingestor/lib too). Gitignore semantics give
 * both properties at once:
 *   - 'dir/' prunes the whole subtree, dot-children included;
 *   - a leading '/' anchors to the staging root, so payload subtrees that
 *     happen to share a name (a plugin's lib/ or scripts/) still stage.
 *
 * EVERY call site that uses these lists MUST pass
 * `ignoreMode: IgnoreMode.GIT` — the patterns are written for it, and
 * lib/utils/lambda-asset-excludes.test.ts enforces both the spread usage
 * and the behavior with aws-cdk-lib's own IgnoreStrategy.git.
 */

/**
 * For `Code.fromAsset('lambda', ...)` bundles (api, jobs, processor,
 * aggregator, research). Spread this into `exclude`, then add the sibling
 * handler dirs that particular bundle does not copy (anchored, e.g.
 * '/aggregator/').
 */
export const PY_LAMBDA_ASSET_EXCLUDES = [
  '__pycache__/',
  '*.pyc',
  '.DS_Store',
  // pytest suites (api/test, shared/test, jobs/*/test) never ship
  'test/',
  'test_*.py',
  'conftest.py',
  // inlined into stacks via readFileSync, never bundled
  '/custom_resources/',
  // pip layer sources + local build output (see python-layer-bundling.ts)
  '/layers/',
  // Node.js streaming Lambda — bundled separately by NodejsFunction
  '/stream/',
];

/**
 * Excludes for one plugin-ingestor bundle, which must stage from the
 * PROJECT ROOT (it copies plugins/<id>/ingestor + plugins/_shared +
 * lambda/shared). Only those three trees may influence the asset hash:
 * sibling plugins are excluded per-id, so editing one plugin no longer
 * redeploys all five ingestors.
 */
export function rootPluginAssetExcludes(pluginId: string, allPluginIds: string[]): string[] {
  return [
    // Any-depth noise inside the staged trees.
    '__pycache__/',
    '*.pyc',
    '.DS_Store',
    'test/',
    'conftest.py',
    'test_*.py',
    // Hash-noise files anywhere (nothing the bundles copy is ts/js/json/md;
    // plugin manifest.json is a synth-time input read from the SOURCE tree,
    // not from the staged asset).
    '*.ts',
    '*.js',
    '*.json',
    '*.md',
    // Top-level-only (anchored): repo/tooling dirs that must never feed the
    // hash — but whose NAMES a plugin payload may legitimately reuse.
    '/.git/',
    '/.vscode/',
    '/.idea/',
    '/.env*',
    '/node_modules/',
    '/cdk.out/',
    '/frontend/',
    '/bin/',
    '/lib/',
    '/dist/',
    '/.venv/',
    '/.pytest_cache/',
    '/.ruff_cache/',
    '/coverage_html/',
    '/.coverage',
    '/.coveragerc',
    '/ruff.toml',
    '/pytest.ini',
    '/requirements-dev.txt',
    '/chrome-extension/',
    '/scripts/',
    '/schemas/',
    '/Workshop/',
    '/plugins/_template/',
    // lambda/: only shared/ ships in ingestor bundles.
    '/lambda/aggregator/',
    '/lambda/api/',
    '/lambda/custom_resources/',
    '/lambda/jobs/',
    '/lambda/layers/',
    '/lambda/processor/',
    '/lambda/research/',
    '/lambda/stream/',
    // Sibling plugins: their edits must not churn THIS plugin's hash.
    ...allPluginIds
      .filter((id) => id !== pluginId)
      .sort()
      .map((id) => `/plugins/${id}/`),
  ];
}
