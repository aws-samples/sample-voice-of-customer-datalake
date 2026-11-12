# Engineering agent image: Rust toolchain (docs/autonomous-engineering.md → Runtime).
# Build from voc-datalake/:  docker build -f engineering-images/rust/Dockerfile \
#   --build-arg MOUNTPOINT_VERSION=<x.y.z> --build-arg MOUNTPOINT_SHA256=<sha256 of that release's .deb> .
# The toolchain's own directories stay root's: `code` never owns a directory on anyone's PATH. A repository's
# rust-toolchain.toml installs into the rustup home under /opt/voc/cache, which `code` owns and no PATH names.
FROM public.ecr.aws/docker/library/rust:1-slim-bookworm

ARG MOUNTPOINT_VERSION
ARG MOUNTPOINT_SHA256
COPY engineering-images/common/install-base.sh /tmp/install-base.sh
RUN sh /tmp/install-base.sh "$MOUNTPOINT_VERSION" "$MOUNTPOINT_SHA256" && rm /tmp/install-base.sh \
 && apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/* \
 && rustup component add clippy rustfmt \
 && cp -a "$RUSTUP_HOME" /opt/voc/cache/rustup && mkdir -p /opt/voc/cache/cargo \
 && chown -R code:work /opt/voc/cache/rustup /opt/voc/cache/cargo

COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py
COPY engineering-images/common/entrypoint.sh /opt/voc/entrypoint.sh
COPY engineering-images/common/check-runner.sh engineering-images/rust/ready.sh engineering-images/rust/validate.sh /opt/voc/hooks/

# The proxies (cargo, rustc) stay in the root-owned /usr/local/cargo/bin on PATH; the toolchains they run and the
# registry cache live in /opt/voc/cache (CARGO_HOME, RUSTUP_HOME), whose bin directories no PATH names.
ENV CARGO_INCREMENTAL=0 CARGO_HOME=/opt/voc/cache/cargo RUSTUP_HOME=/opt/voc/cache/rustup
WORKDIR /work
EXPOSE 8080
# The runner starts as root only to drop every command to `code` or `unit` (unit_runner.sandboxed_argv).
ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]
