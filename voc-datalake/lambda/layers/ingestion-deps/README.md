# ingestion-deps layer

Dependencies for the ingestion plugin Lambdas (ARM64/Graviton).

Only `requirements.txt` matters here. The deployed layer contains ONLY what
pip installs from it — via `lib/utils/python-layer-bundling.ts` at CDK synth
time, or `scripts/build-layers.sh` for manual builds (same recipe, guarded by
`lib/utils/python-layer-bundling.test.ts`).

Do NOT place first-party code in this directory: it will silently not deploy.
Shared runtime code belongs in `lambda/shared/` (or `plugins/_shared/` for
plugin-only helpers).

Notes:

- `python/` is local build output from `scripts/build-layers.sh`; it is
  excluded from the CDK asset and can be deleted at any time.
- boto3/botocore are stripped from the built layer on purpose — the Lambda
  runtime provides a matched pair, and shipping a transitive botocore
  shadows it (issue #194). If you ever need a newer SDK than the runtime
  ships, vendor boto3 AND botocore together and remove the strip.
