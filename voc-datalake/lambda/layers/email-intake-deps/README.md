# email-intake-deps layer

lxml, the HTML parser `lambda/email_intake/mime.py` hands BeautifulSoup. Deployed as
`EmailIntakeDepsLayer` in VocIngestionStack, only when the inbound-email intake is
enabled (`-c inboundEmailDomain=...`), and attached only to that function; bs4 comes
from `../ingestion-deps`, which the intake carries too.

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
