# Engineering agent image: Python toolchain (docs/autonomous-engineering.md → Runtime).
# Build from voc-datalake/:  docker build -f engineering-images/python/Dockerfile \
#   --build-arg MOUNTPOINT_VERSION=<x.y.z> --build-arg MOUNTPOINT_SHA256=<sha256 of that release's .deb> .
# The MicroVM image is made from this with the ready and validate hooks beside it.
FROM public.ecr.aws/docker/library/python:3.14-slim

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
ARG BOTO3_VERSION
COPY engineering-images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION" && rm /tmp/install-base.sh

COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py
# The harness, root-owned and outside the checkout: the runtime's pure modules and the harness package.
COPY lambda/engineering/__init__.py /opt/voc/engineering/__init__.py
COPY lambda/engineering/runtime/__init__.py lambda/engineering/runtime/interface.py lambda/engineering/runtime/tokens.py lambda/engineering/runtime/checkout.py lambda/engineering/runtime/checkpoints.py lambda/engineering/runtime/unit_runner.py /opt/voc/engineering/runtime/
COPY lambda/engineering/connectors/__init__.py lambda/engineering/connectors/identity.py /opt/voc/engineering/connectors/
COPY lambda/engineering/runtime/harness/*.py /opt/voc/engineering/runtime/harness/
COPY engineering-images/common/harness.py /opt/voc/harness.py
COPY engineering-images/common/entrypoint.sh /opt/voc/entrypoint.sh
COPY engineering-images/common/check-runner.sh engineering-images/python/ready.sh engineering-images/python/validate.sh /opt/voc/hooks/

ENV PIP_CACHE_DIR=/opt/voc/cache/pip
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
