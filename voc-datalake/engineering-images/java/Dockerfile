# Engineering agent image: Java toolchain (docs/autonomous-engineering.md → Runtime).
# Build from voc-datalake/:  docker build -f engineering-images/java/Dockerfile \
#   --build-arg MOUNTPOINT_VERSION=<x.y.z> --build-arg MOUNTPOINT_SHA256=<sha256 of that release's .deb> .
# Maven is installed; a Gradle repository brings its own wrapper (./gradlew).
FROM public.ecr.aws/docker/library/eclipse-temurin:21-jdk

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
COPY engineering-images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" && rm /tmp/install-base.sh \
 && apt-get update && apt-get install -y --no-install-recommends maven && rm -rf /var/lib/apt/lists/*

COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py
COPY engineering-images/common/entrypoint.sh /opt/voc/entrypoint.sh
COPY engineering-images/common/check-runner.sh engineering-images/java/ready.sh engineering-images/java/validate.sh /opt/voc/hooks/

ENV GRADLE_USER_HOME=/opt/voc/cache/gradle MAVEN_OPTS=-Dmaven.repo.local=/opt/voc/cache/m2
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
