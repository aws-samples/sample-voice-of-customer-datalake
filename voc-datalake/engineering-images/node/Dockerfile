# Engineering agent image: Node.js toolchain (docs/autonomous-engineering.md → Runtime), pinned to the typescript gate
# pack's [image] version (templates/orchestration/gates/typescript: Node 24; test_engineering_images.py holds it).
# Build from voc-datalake/ (docs/deployment.md, "engineeringImages"):  docker buildx build --platform linux/arm64 \
#   -f engineering-images/node/Dockerfile --build-arg MOUNTPOINT_VERSION=<x.y.z> \
#   --build-arg MOUNTPOINT_SHA256=<sha256 of that release's arm64 .deb> --build-arg BOTO3_VERSION=<x.y.z> .
# AgentCore Runtime (platform version V2) runs arm64 images: built for linux/arm64 (docs/deployment.md).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:24.22.3-bookworm-slim

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
ARG BOTO3_VERSION
COPY engineering-images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION" && rm /tmp/install-base.sh

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
COPY templates/orchestration/gates/ /opt/voc/gates/
COPY engineering-images/common/harness.py /opt/voc/harness.py
COPY engineering-images/common/entrypoint.sh /opt/voc/entrypoint.sh
COPY engineering-images/common/check-runner.sh engineering-images/node/ready.sh engineering-images/node/validate.sh /opt/voc/hooks/

ENV NPM_CONFIG_CACHE=/opt/voc/cache/npm
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
