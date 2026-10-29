# signing-deps layer

cryptography (+ cffi, pycparser) for `shared/cloudfront_signing.py`, the RSA-SHA1
primitive of CloudFront signed URLs (persona avatars, prototypes). Deployed as
`SigningDepsLayer` in VocApiStack and attached ONLY to the functions whose code can
sign: `SIGNING_LAYER_FUNCTION_IDS` in `lib/utils/dependency-layers.ts`. The other
API and processing Lambdas no longer unzip ~16 MB they never import.

Only `requirements.txt` matters here. The deployed layer contains ONLY what
pip installs from it — via `lib/utils/python-layer-bundling.ts` at CDK synth
time, or `scripts/build-layers.sh` for manual builds (same recipe, guarded by
`lib/utils/python-layer-bundling.test.ts`).

Do NOT place first-party code in this directory: it will silently not deploy.

Notes:

- `python/` is local build output from `scripts/build-layers.sh`; it is
  excluded from the CDK asset and can be deleted at any time.
- The bundling strips what the Lambda runtime already ships (boto3, botocore,
  s3transfer, jmespath, python-dateutil, six, urllib3: a layer copy would
  shadow the runtime's, issue #194) and what never runs in Lambda (`bin/`,
  `*.pyi`, `*-stubs`, packaged `tests/`): `LAYER_STRIP` in
  `lib/utils/python-layer-bundling.ts`. If you ever need a newer SDK than the
  runtime ships, vendor boto3 AND botocore together and remove that strip.
- `scripts/audit/py_layers.py` (a gate step) reports a library no attached
  function reaches, one only a few of them reach, and a function that imports
  a library none of its layers ships (docs/code-audit.md).
