import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Creates the throwaway venv directory the bundling command builds in.
 *
 * `mktemp -d` gives a fresh, unguessable directory with mode 0700 instead of a
 * fixed, predictable path under the world-writable temp dir (CWE-377/379: a
 * hard-coded `/tmp/<name>` can be pre-created or symlinked by another process).
 * It runs inside the single-use bundling container, so the directory is still
 * discarded with the container. scripts/build-layers.sh uses the same two
 * shell fragments inside its container; the lockstep test pins both.
 */
export const BUILD_VENV_SETUP = 'venv="$(mktemp -d)"';

/** Shell reference to the venv created by {@link BUILD_VENV_SETUP}. */
export const BUILD_VENV = '"$venv"';

/**
 * What the bundling deletes from `python/` after pip, relative to it (globs).
 *
 * The first group is the AWS SDK closure the Lambda Python 3.14 runtime ships in
 * `/var/lang/lib/python3.14/site-packages` (boto3, botocore, s3transfer, jmespath,
 * python-dateutil, six, urllib3: `RUNTIME_PROVIDED` in scripts/audit/layer_dists.py,
 * checked against the image by its test). A layer copy SHADOWS the runtime's
 * (`/opt/python` precedes it on `sys.path`), so the runtime's botocore would run on
 * the layer's urllib3 / dateutil / jmespath instead of the versions it was released
 * with. Every layer distribution's range accepts the runtime's versions (requests and
 * app-store-web-scraper: urllib3 <3, Powertools: jmespath <2; botocore itself caps
 * urllib3 below 3); `py_layers` reports a `runtime-conflict` the day one does not.
 *
 * The second group never runs in Lambda: pip's console scripts (`bin/`, not on
 * `sys.path`), type stubs (`*-stubs` packages; `*.pyi` files are deleted by a `find`
 * below) and the test suites some wheels ship (`certifi/tests`, `websocket/tests`;
 * no library module imports them). `.pyc` and `*.dist-info` stay: the bytecode is
 * compiled for 3.14 by the same image (no compile at cold start), and the metadata
 * is what `importlib.metadata` reads.
 */
export const LAYER_STRIP = [
  'boto3', 'boto3-*', 'botocore', 'botocore-*', 's3transfer', 's3transfer-*',
  'jmespath', 'jmespath-*', 'dateutil', 'python_dateutil-*', 'six.py', 'six-*', 'urllib3', 'urllib3-*',
  'bin', '*-stubs',
] as const;

/** The strip steps, rooted at `pythonDir` (`/asset-output/python` here, `/var/task/python` in build-layers.sh). */
export function layerStripSteps(pythonDir: string): string {
  const targets = LAYER_STRIP.map((entry) => `${pythonDir}/${entry}`).join(' ');
  return `rm -rf ${targets}`
    + ` && find ${pythonDir} -name "*.pyi" -type f -delete`
    + ` && find ${pythonDir} -mindepth 2 -type d -name tests -prune -exec rm -rf {} +`;
}

/**
 * Bundled asset for a Python dependency layer, kept in lockstep with
 * scripts/build-layers.sh (issue #194) — lib/utils/python-layer-bundling.test.ts
 * fails if the two recipes drift. Every LayerVersion in the app must use
 * this instead of an inline `pip install` (also enforced by that test).
 *
 * ONLY pip-installed dependencies ship: any first-party files placed next to
 * requirements.txt in a layer dir are NOT deployed (see the README in each
 * layer dir). Put shared runtime code in lambda/shared/ instead.
 *
 * Why not a plain `pip install -t /asset-output/python`:
 *
 * - Lambda's Python runtime PROVIDES boto3/botocore as a matched pair (and
 *   the rest of the SDK closure: {@link LAYER_STRIP}), but
 *   aws-lambda-powertools[tracer] -> aws-xray-sdk pulls botocore in
 *   transitively. Shipping that botocore (without boto3) is harmful:
 *   /opt/python precedes the runtime site-packages on sys.path, so the runtime's boto3
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
 * OPT-OUT: the strip deliberately couples layers to the runtime-provided
 * SDK version. If a layer ever NEEDS a newer SDK than the runtime ships
 * (e.g. a Bedrock API the runtime's boto3 doesn't know yet), do not just
 * pin botocore — vendor boto3 AND botocore together as an explicitly
 * matched pair and remove the strip for that layer, or the pin is
 * silently defeated.
 *
 * The local `python/` build output from scripts/build-layers.sh is excluded
 * from the asset input: the container installs fresh from requirements.txt,
 * and staging it would nest a stale copy inside the deployed layer and churn
 * the asset hash on every local rebuild. README.md and .DS_Store are
 * excluded for the same hash-stability reason.
 */
export function pythonLayerCode(layerDir: string): lambda.Code {
  return lambda.Code.fromAsset(layerDir, {
    exclude: ['python', 'README.md', '**/.DS_Store'],
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      platform: 'linux/arm64',
      command: [
        'bash', '-c',
        BUILD_VENV_SETUP
        + ` && python -m venv ${BUILD_VENV}`
        + ` && ${BUILD_VENV}/bin/pip install -r requirements.txt -t /asset-output/python`
        + ' --upgrade --quiet --no-cache-dir --root-user-action=ignore --disable-pip-version-check'
        + ` && ${layerStripSteps('/asset-output/python')}`,
      ],
    },
  });
}
