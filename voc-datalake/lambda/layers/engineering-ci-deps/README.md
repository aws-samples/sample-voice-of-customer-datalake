# engineering-ci-deps layer

PyYAML for `lambda/engineering/connectors/ci_yaml.py`, the engineering broker's strict reader of a GitLab project's
CI files (docs/autonomous-engineering.md, "CI definitions on GitLab"). Deployed as `EngineeringCiDepsLayer` in
VocProcessingStack, attached ONLY to the broker, and only with `-c engineeringAgents=true`.

Only `requirements.txt` matters here. The deployed layer contains ONLY what pip installs from it, via
`lib/utils/python-layer-bundling.ts` at CDK synth time, or `scripts/build-layers.sh` for manual builds.

Do NOT place first-party code in this directory: it will silently not deploy.
