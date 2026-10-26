/**
 * Preload for the Python audit synth (scripts/audit/py_assembly.py): records every bundled asset.
 *
 * Loaded with `node -r <this file> -r ts-node/register bin/voc-datalake.ts`. The audit synth skips
 * Docker bundling (`aws:cdk:bundling-stacks: []`, exactly like lib/test-support/synth-app.ts), so
 * the cloud assembly holds the SOURCE directory of each asset, never the bundle that deploys. What
 * ships is decided by the bundling command (`cp -r /asset-input/shared /asset-output/` ...). CDK
 * does not write that command into the assembly, so this preload wraps
 * `AssetStaging.prototype.stageByBundling` and writes, at exit, one record per asset:
 * `{ assetHash, sourcePath, command }` to the file named by `VOC_AUDIT_BUNDLING_OUT`.
 * py_assembly.py replays the `cp` steps of each command over the source tree.
 */
'use strict';

const { writeFileSync } = require('node:fs');

const out = process.env.VOC_AUDIT_BUNDLING_OUT;
if (out) {
  // The package root export IS the class every construct instantiates, so its prototype is the hook.
  const { AssetStaging } = require(require.resolve('aws-cdk-lib', { paths: [process.cwd()] }));
  const original = AssetStaging.prototype.stageByBundling;
  const originalCopy = AssetStaging.prototype.stageByCopying;
  const records = [];
  AssetStaging.prototype.stageByBundling = function stageByBundlingRecorded(bundling, skip) {
    const staged = original.call(this, bundling, skip);
    records.push({
      assetHash: staged.assetHash,
      sourcePath: this.sourcePath,
      command: Array.isArray(bundling.command) ? bundling.command : [],
    });
    return staged;
  };
  // An asset without a `bundling` block ships its (exclude-filtered) source directory as-is.
  AssetStaging.prototype.stageByCopying = function stageByCopyingRecorded() {
    const staged = originalCopy.call(this);
    records.push({ assetHash: staged.assetHash, sourcePath: this.sourcePath, command: null });
    return staged;
  };
  process.on('exit', () => {
    writeFileSync(out, JSON.stringify(records));
  });
}
