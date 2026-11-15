#!/bin/sh
# Validate hook: the toolchain runs and the unit runner answers.
set -eu
# Hooks run as root before any repository code: never from a directory a repository can write.
cd /
cargo --version
cargo clippy --version
cargo fmt --version
git --version
exec sh /opt/voc/hooks/check-runner.sh cargo --version
