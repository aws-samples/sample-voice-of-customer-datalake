# Engineering agent image: Java toolchain (docs/autonomous-engineering.md → Runtime).
# Build from voc-datalake/:  docker build -f engineering-images/java/Dockerfile \
#   --build-arg MOUNTPOINT_VERSION=<x.y.z> --build-arg MOUNTPOINT_SHA256=<sha256 of that release's .deb> .
# Maven is installed; a Gradle repository brings its own wrapper (./gradlew).
# AgentCore Runtime (platform version V2) runs arm64 images: built for linux/arm64 (docs/deployment.md).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/eclipse-temurin:21-jdk

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
ARG BOTO3_VERSION
COPY engineering-images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION" && rm /tmp/install-base.sh \
 && apt-get update && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*

COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py
# The harness, root-owned and outside the checkout: the runtime's pure modules and the harness package.
COPY lambda/engineering/__init__.py /opt/voc/engineering/__init__.py
COPY lambda/engineering/runtime/__init__.py lambda/engineering/runtime/interface.py lambda/engineering/runtime/tokens.py lambda/engineering/runtime/checkout.py lambda/engineering/runtime/checkpoints.py lambda/engineering/runtime/outputs.py lambda/engineering/runtime/unit_runner.py /opt/voc/engineering/runtime/
COPY lambda/engineering/connectors/__init__.py lambda/engineering/connectors/identity.py /opt/voc/engineering/connectors/
COPY lambda/engineering/runtime/harness/*.py /opt/voc/engineering/runtime/harness/
COPY engineering-images/common/harness.py /opt/voc/harness.py
COPY engineering-images/common/entrypoint.sh /opt/voc/entrypoint.sh
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
