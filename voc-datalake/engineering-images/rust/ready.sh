#!/bin/sh
# Ready hook: warm the crates.io index so an agent's first `cargo fetch` starts warm.
# Reaches only the Rust egress allowlist (index.crates.io, static.crates.io, crates.io).
set -eu
# Hooks run as root before any repository code: never from a directory a repository can write.
cd /
# Under root's own home: cargo reads .cargo/config.toml from every parent directory, and /tmp is anyone's.
scratch="$(mktemp -d -p /root)"
trap 'rm -rf "$scratch"' EXIT
cargo new --quiet --vcs none "$scratch/warm"
cd "$scratch/warm"
cargo add --quiet serde@1 >/dev/null
cargo fetch --quiet
chown -R code:work "$CARGO_HOME"
