/**
 * Shared staging excludes for Python Lambda `Code.fromAsset('lambda', ...)`
 * bundles (issue #194 follow-up).
 *
 * Everything staged feeds the CDK asset hash — even files the bundling
 * command never copies into /asset-output. Without these excludes, local
 * layer build output (lambda/layers/&#42;/python from scripts/build-layers.sh),
 * the Node streaming Lambda's 141MB node_modules, tests, and caches were
 * hashed into every Python function asset, so unrelated edits redeployed
 * all ~25 functions with byte-identical code on every `cdk deploy`.
 *
 * Spread this into the `exclude` of EVERY fromAsset('lambda') call, then add
 * the sibling handler dirs that particular bundle does not copy
 * (lib/utils/lambda-asset-excludes.test.ts enforces the spread).
 */
export const PY_LAMBDA_ASSET_EXCLUDES = [
  '**/__pycache__',
  '**/*.pyc',
  '**/.DS_Store',
  '**/test/**',        // pytest suites (api/test, shared/test, jobs/*/test) never ship
  '**/test_*.py',      // stray test modules outside test/ dirs
  '**/conftest.py',
  'custom_resources/**', // inlined into stacks via readFileSync, never bundled
  'layers/**',         // pip layer sources + local build output (see python-layer-bundling.ts)
  'stream/**',         // Node.js streaming Lambda — bundled separately by NodejsFunction
];
