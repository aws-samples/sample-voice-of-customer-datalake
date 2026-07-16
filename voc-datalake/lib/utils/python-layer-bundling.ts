import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Bundled asset for a Python dependency layer, kept in lockstep with
 * scripts/build-layers.sh (issue #194). Every LayerVersion in the app must
 * use this instead of an inline `pip install` command.
 *
 * Why not a plain `pip install -t /asset-output/python`:
 *
 * - Lambda's Python runtime PROVIDES boto3/botocore as a matched pair, but
 *   aws-lambda-powertools[tracer] -> aws-xray-sdk pulls botocore in
 *   transitively. Shipping that botocore (without boto3) is harmful:
 *   /opt/python precedes /var/runtime on sys.path, so the runtime's boto3
 *   would be paired with the layer's mismatched botocore — the exact
 *   incompatibility pip's resolver error warns about. Stripping it also
 *   cuts ~15MB per layer.
 * - pip runs from a THROWAWAY VENV inside the container: the build image
 *   preinstalls boto3 in its system site-packages, and pip's post-install
 *   consistency check compares it against the target dir's botocore,
 *   printing a scary-but-irrelevant "dependency resolver" ERROR on every
 *   synth — a clean venv has nothing installed, so there is nothing to
 *   conflict with.
 * - The remaining flags silence build-container noise that isn't actionable
 *   in a throwaway container: --no-cache-dir (unwritable ~/.cache warning),
 *   --root-user-action=ignore (root-user warning),
 *   --disable-pip-version-check (self-update notice).
 *
 * The local `python/` build output from scripts/build-layers.sh is excluded
 * from the asset input: the container installs fresh from requirements.txt,
 * and staging it would nest a stale copy inside the deployed layer and churn
 * the asset hash on every local rebuild.
 */
export function pythonLayerCode(layerDir: string): lambda.Code {
  return lambda.Code.fromAsset(layerDir, {
    exclude: ['python', '.DS_Store'],
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      platform: 'linux/arm64',
      command: [
        'bash', '-c',
        'python -m venv /tmp/buildenv'
        + ' && /tmp/buildenv/bin/pip install -r requirements.txt -t /asset-output/python'
        + ' --upgrade --quiet --no-cache-dir --root-user-action=ignore --disable-pip-version-check'
        + ' && rm -rf /asset-output/python/boto3 /asset-output/python/botocore'
        + ' /asset-output/python/boto3-* /asset-output/python/botocore-*',
      ],
    },
  });
}
