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
 * PATTERN SEMANTICS (issue #203 — this bit us hard): CDK matches each
 * pattern with `minimatch(relativePath, pattern, { matchBase: true })`, and
 * `**` NEVER crosses a dot segment. Consequences:
 *   - `'dir/**'` excludes dir's plain children but NOT its dot-children —
 *     `'cdk.out/**'` left `cdk.out/.cache/*.zip` (CDK's own publishing
 *     cache!) in the fingerprint, so every deploy changed the next synth's
 *     ingestor asset hashes, forever.
 *   - Excluding the DIRECTORY ITSELF ('cdk.out', or path-qualified
 *     'lambda/layers') prunes the whole subtree via completelyIgnores —
 *     dot-children included. ALWAYS name directories; never append '/**'.
 *   - matchBase applies to slash-less patterns only: bare 'test' matches a
 *     dir named test at ANY depth; 'lambda/layers' matches exactly that
 *     path.
 *
 * lib/utils/lambda-asset-excludes.test.ts enforces both the spread usage in
 * the stacks and the dot-child behavior with aws-cdk-lib's own
 * IgnoreStrategy.
 */

/**
 * For `Code.fromAsset('lambda', ...)` bundles (api, jobs, processor,
 * aggregator, research). Spread this into `exclude`, then add the sibling
 * handler dirs that particular bundle does not copy.
 */
export const PY_LAMBDA_ASSET_EXCLUDES = [
  '__pycache__',
  '*.pyc',
  '.DS_Store',
  // pytest suites (api/test, shared/test, jobs/*/test) never ship
  'test',
  'test_*.py',
  'conftest.py',
  // inlined into stacks via readFileSync, never bundled
  'custom_resources',
  // pip layer sources + local build output (see python-layer-bundling.ts)
  'layers',
  // Node.js streaming Lambda — bundled separately by NodejsFunction
  'stream',
];

/**
 * For the plugin ingestor bundles, which must stage from the PROJECT ROOT
 * (they copy plugins/<id>/ingestor + plugins/_shared + lambda/shared). Only
 * those three trees may influence the asset hash — everything else here is
 * noise, and dot-children of excluded dirs must be pruned too (see module
 * doc). Bare names match at any depth by design (e.g. 'dist' also covers
 * lambda/stream/dist).
 */
export const ROOT_PLUGIN_ASSET_EXCLUDES = [
  '__pycache__',
  '*.pyc',
  '.DS_Store',
  'test',
  'conftest.py',
  'test_*.py',
  'node_modules',
  'cdk.out',
  'frontend',
  '*.ts',
  '*.js',
  '*.json',
  '*.md',
  'bin',
  'lib',
  'dist',
  '.venv',
  '.pytest_cache',
  '.ruff_cache',
  'coverage_html',
  '.coverage',
  '.coveragerc',
  'ruff.toml',
  'pytest.ini',
  'requirements-dev.txt',
  'chrome-extension',
  'scripts',
  'schemas',
  'Workshop',
  'plugins/_template',
  'lambda/aggregator',
  'lambda/api',
  'lambda/custom_resources',
  'lambda/jobs',
  'lambda/layers',
  'lambda/processor',
  'lambda/research',
  'lambda/stream',
];
