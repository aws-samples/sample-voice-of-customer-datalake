# Engineering agent image: Java toolchain (docs/autonomous-engineering.md → Runtime), pinned to the java gate pack's
# [image] versions (templates/orchestration/gates/java: Temurin 25, Maven 3.9.16, Gradle 9.8.0;
# test_engineering_images.py holds them). Maven and Gradle come from their release archives, each checked against
# its published checksum; a Gradle repository's own wrapper (./gradlew) still runs its own version.
# Build from voc-datalake/ (docs/deployment.md, "engineeringImages"):  docker buildx build --platform linux/arm64 \
#   -f engineering-images/java/Dockerfile --build-arg MOUNTPOINT_VERSION=<x.y.z> \
#   --build-arg MOUNTPOINT_SHA256=<sha256 of that release's arm64 .deb> --build-arg BOTO3_VERSION=<x.y.z> .
# AgentCore Runtime (platform version V2) runs arm64 images: built for linux/arm64 (docs/deployment.md).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/eclipse-temurin:25.0.5_8-jdk-noble

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
ARG BOTO3_VERSION
COPY engineering-images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION" && rm /tmp/install-base.sh

# Maven and Gradle, root-owned under /opt, on PATH through /usr/local/bin (which `code` cannot write).
COPY engineering-images/java/install-build-tools.sh /tmp/install-build-tools.sh
RUN sh /tmp/install-build-tools.sh 3.9.16 \
      831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6 \
      9.8.0 bafd5ce9cfaea0fbccfdc8439a1ac42fbd4cd9c89dc9a988228d8a2639a58e6c \
 && rm /tmp/install-build-tools.sh

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
COPY engineering-images/common/entrypoint.sh engineering-images/common/walls.sh /opt/voc/
COPY engineering-images/common/check-runner.sh engineering-images/java/ready.sh engineering-images/java/validate.sh /opt/voc/hooks/
# Maven reads no HTTPS_PROXY: the dependency step's settings point it at its own egress proxy (the firewall holds it
# there either way).
COPY engineering-images/java/maven-settings.xml /home/code/.m2/settings.xml

# No Gradle daemon: it talks to its client over loopback, which the code firewall rejects in the dependency step
# (entrypoint.sh). The runner passes it to repository code (unit_runner.TOOLCHAIN_ENV).
ENV GRADLE_USER_HOME=/opt/voc/cache/gradle MAVEN_OPTS=-Dmaven.repo.local=/opt/voc/cache/m2 \
    GRADLE_OPTS=-Dorg.gradle.daemon=false
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
