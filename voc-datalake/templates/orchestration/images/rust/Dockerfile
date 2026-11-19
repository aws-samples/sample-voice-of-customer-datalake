# Engineering agent image: Rust toolchain, and Node.js for a repository's TypeScript half
# (docs/autonomous-engineering.md → Runtime), pinned to the gate packs' [image] versions
# (templates/orchestration/gates/rust: Rust 1.99.1; typescript: Node 24; test_engineering_images.py holds them).
# Build from voc-datalake/ (docs/deployment.md, "engineeringImages"):  docker buildx build --platform linux/arm64 \
#   -f templates/orchestration/images/rust/Dockerfile --build-arg MOUNTPOINT_VERSION=<x.y.z> \
#   --build-arg MOUNTPOINT_SHA256=<sha256 of that release's arm64 .deb> --build-arg BOTO3_VERSION=<x.y.z> .
# The toolchain's own directories stay root's: `code` never owns a directory on anyone's PATH. A repository's
# rust-toolchain.toml installs into the rustup home under /opt/voc/cache, which `code` owns and no PATH names.
# AgentCore Runtime (platform version V2) runs arm64 images: built for linux/arm64 (docs/deployment.md).
FROM --platform=linux/arm64 public.ecr.aws/docker/library/rust:1.99.1-slim-bookworm

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
ARG BOTO3_VERSION
COPY templates/orchestration/images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" "$BOTO3_VERSION" && rm /tmp/install-base.sh \
 && apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/* \
 && rustup component add clippy rustfmt \
 && cp -a "$RUSTUP_HOME" /opt/voc/cache/rustup && mkdir -p /opt/voc/cache/cargo \
 && chown -R code:work /opt/voc/cache/rustup /opt/voc/cache/cargo
# Node.js from its official release tarball, checked against the release's SHASUMS256.txt, root-owned under /opt/node
# (on PATH through /usr/local/bin, which `code` cannot write): a repository's TypeScript half (rust-ts).
COPY templates/orchestration/images/common/install-node.sh /tmp/install-node.sh
RUN sh /tmp/install-node.sh 24.22.3 261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 \
 && rm /tmp/install-node.sh

# Kiro CLI (7.53.00, the Kiro harness: -c engineeringHarness), pinned, its archive checked against the sha256 Kiro
# publishes in its release index (templates/orchestration/images/common/install-kiro.sh; test_engineering_images.py
# holds the version equal to harness/kiro.py KIRO_CLI_VERSION).
COPY templates/orchestration/images/common/install-kiro.sh /tmp/install-kiro.sh
RUN sh /tmp/install-kiro.sh 3.4.0 187905a1c931fde45ef0e03edd80d201f4f608e1a844d9508d80f558a593d499 \
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
COPY templates/orchestration/images/common/check-runner.sh templates/orchestration/images/rust/ready.sh templates/orchestration/images/rust/validate.sh /opt/voc/hooks/

# The proxies (cargo, rustc) stay in the root-owned /usr/local/cargo/bin on PATH; the toolchains they run and the
# registry cache live in /opt/voc/cache (CARGO_HOME, RUSTUP_HOME), whose bin directories no PATH names.
ENV CARGO_INCREMENTAL=0 CARGO_HOME=/opt/voc/cache/cargo RUSTUP_HOME=/opt/voc/cache/rustup \
    NPM_CONFIG_CACHE=/opt/voc/cache/npm
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
