#!/bin/sh
# Kiro CLI (7.53.00), for the Kiro harness: kiro-cli over ACP, run by the harness as the agent user, in the agent's own
# namespace, its only way out the agent's egress proxy (docs/autonomous-engineering.md, "The Kiro harness (7.53.00)").
# Every image installs it, so switching a deployment to Kiro (-c engineeringHarness) needs no other image. Run as root
# at build time, after install-base.sh.
#
# Usage: install-kiro.sh <version> <sha256 of kirocli-aarch64-linux-musl.tar.gz of that version>
# The version and its checksum are pinned in the Dockerfile, as Kiro publishes them in its release index
# (https://prod.download.cli.kiro.dev/stable/index.json: each version's packages with their sha256, which the official
# installer, https://cli.kiro.dev/install, checks the same way) and checked here: the build fails rather than install an
# archive it cannot verify. The musl build, statically linked, runs on every image's base (the glibc aarch64 build
# needs glibc 2.39, which Debian bookworm does not have). Only the one binary is taken from the archive, root's, at
# /usr/local/bin/kiro-cli (which `code` cannot write); its version goes to /opt/voc/kiro/VERSION, which the runner reports
# (unit_runner.kiro_cli_version) and readiness's `kiro` check compares with the pinned one.
set -eu
version="${1:?the kiro-cli version to install}"
expected="${2:?the sha256 of kirocli-aarch64-linux-musl.tar.gz of that version}"
case "$(dpkg --print-architecture)" in
  arm64) arch=aarch64 ;;
  *) echo 'the kiro-cli archive pinned here is for linux-arm64 (AgentCore Runtime V2 runs arm64)' >&2; exit 1 ;;
esac
apt-get update
apt-get install -y --no-install-recommends curl
curl -fsSLo /tmp/kiro.tar.gz "https://prod.download.cli.kiro.dev/stable/${version}/kirocli-${arch}-linux-musl.tar.gz"
echo "${expected}  /tmp/kiro.tar.gz" | sha256sum -c -
mkdir -p /tmp/kiro
tar -xzf /tmp/kiro.tar.gz -C /tmp/kiro --no-same-owner kirocli/bin/kiro-cli
install -o root -g root -m 0755 /tmp/kiro/kirocli/bin/kiro-cli /usr/local/bin/kiro-cli
rm -rf /tmp/kiro /tmp/kiro.tar.gz
apt-get purge -y curl
apt-get autoremove -y
rm -rf /var/lib/apt/lists/*
# The binary says the version it is, from a home of its own (nothing of root's is written); the build fails otherwise.
check_home=$(mktemp -d)
shown=$(HOME="$check_home" /usr/local/bin/kiro-cli --version)
rm -rf "$check_home"
[ "$shown" = "kiro-cli ${version}" ] || { echo "kiro-cli says '${shown}', not ${version}" >&2; exit 1; }
mkdir -p /opt/voc/kiro
printf '%s\n' "$version" > /opt/voc/kiro/VERSION
chmod 0644 /opt/voc/kiro/VERSION
# (no setuid or setgid file comes with it: install-base.sh's sweep holds for the whole image)
chmod ug-s /usr/local/bin/kiro-cli
