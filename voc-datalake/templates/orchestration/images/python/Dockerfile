# Engineering agent image: Python toolchain, and Node.js for a repository's TypeScript half (docs/autonomous-engineering.md
# → Runtime). The toolchains are pinned to the gate packs' [image] versions (templates/orchestration/gates/python: Python
# 3.12, Node 24; test_engineering_images.py holds them equal).
# Build from voc-datalake/ (docs/deployment.md, "engineeringImages"):  docker buildx build --platform linux/arm64 \
#   -f templates/orchestration/images/python/Dockerfile --build-arg MOUNTPOINT_VERSION=<x.y.z> \
#   --build-arg MOUNTPOINT_SHA256=<sha256 of that release's arm64 .deb> --build-arg BOTO3_VERSION=<x.y.z> .
# AgentCore Runtime (platform version V2) runs arm64 images: build for linux/arm64 and push to the stack's
# repository for the language (docs/deployment.md), which an AgentCore runtime then runs.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.12.16-slim-bookworm

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
ARG BOTO3_VERSION
COPY templates/orchestration/images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION" && rm /tmp/install-base.sh
# Node.js from its official release tarball, checked against the release's SHASUMS256.txt, root-owned under /opt/node
# (on PATH through /usr/local/bin, which `code` cannot write).
COPY templates/orchestration/images/common/install-node.sh /tmp/install-node.sh
RUN sh /tmp/install-node.sh 24.22.3 261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 \
 && rm /tmp/install-node.sh

# Kiro CLI (7.53.00, the Kiro harness: -c engineeringHarness), pinned, its archive checked against the sha256 Kiro
# publishes in its release index (templates/orchestration/images/common/install-kiro.sh; test_engineering_images.py
# holds the version equal to harness/kiro.py KIRO_CLI_VERSION).
COPY templates/orchestration/images/common/install-kiro.sh /tmp/install-kiro.sh
RUN sh /tmp/install-kiro.sh 3.5.0 6b931d7c003eb695b33718187180f6721c89e2218d977fccb63e8430fd504db1 \
 && rm /tmp/install-kiro.sh

COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py
# The harness, root-owned and outside the checkout: the runtime's pure modules and the harness package.
COPY lambda/engineering/__init__.py /opt/voc/engineering/__init__.py
COPY lambda/engineering/runtime/__init__.py lambda/engineering/runtime/interface.py lambda/engineering/runtime/tokens.py lambda/engineering/runtime/checkout.py lambda/engineering/runtime/checkpoints.py lambda/engineering/runtime/outputs.py lambda/engineering/runtime/unit_runner.py /opt/voc/engineering/runtime/
COPY lambda/engineering/connectors/__init__.py lambda/engineering/connectors/identity.py /opt/voc/engineering/connectors/
COPY lambda/engineering/runtime/harness/*.py /opt/voc/engineering/runtime/harness/
# The deterministic gate (7.50.00, the gate runner's run_gate): the stdlib-only gate modules, the orchestration loader
# (bundle.py, never the compiler) and its bundle, and the gate packs at /opt/voc/gates
# (quality_gate/packs.py default_packs_dir in an image).
COPY lambda/engineering/quality_gate/__init__.py lambda/engineering/quality_gate/packs.py lambda/engineering/quality_gate/checks.py lambda/engineering/quality_gate/runner.py lambda/engineering/quality_gate/text.py /opt/voc/engineering/quality_gate/
COPY lambda/engineering/orchestration/__init__.py lambda/engineering/orchestration/bundle.py /opt/voc/engineering/orchestration/
COPY templates/orchestration/bundle.json /opt/voc/orchestration/bundle.json
# The compiled Kiro agent configs (7.53.00): the Kiro harness writes a session's agent from its role's.
COPY templates/orchestration/kiro-agents/ /opt/voc/orchestration/kiro-agents/
COPY templates/orchestration/gates/ /opt/voc/gates/
COPY templates/orchestration/images/common/harness.py /opt/voc/harness.py
COPY templates/orchestration/images/common/entrypoint.sh templates/orchestration/images/common/walls.sh /opt/voc/
COPY templates/orchestration/images/common/check-runner.sh templates/orchestration/images/python/ready.sh templates/orchestration/images/python/validate.sh /opt/voc/hooks/

ENV PIP_CACHE_DIR=/opt/voc/cache/pip NPM_CONFIG_CACHE=/opt/voc/cache/npm
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
