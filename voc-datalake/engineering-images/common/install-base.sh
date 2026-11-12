#!/bin/sh
# Shared by every engineering image (run as root at build time, on a Debian-based toolchain image):
# git, util-linux (setpriv, unshare: the runner's sandbox), iproute2 (a boxed command's own loopback), iptables
# (the code firewall), python3 (the runner), Mountpoint for Amazon S3 (the read-only cache mount), and the two users:
# `unit` (the agent: the harness, the broker calls) and `code` (repository code: builds, tests, gate tools), both in
# the group `work`, which owns only /work.
#
# Usage: install-base.sh <mountpoint-version> <sha256 of that version's .deb for this architecture> <boto3-version>
# Mountpoint is pinned and checked: the build fails rather than install a package it cannot verify. boto3 (the
# harness's only dependency: Bedrock and S3) is pinned to one version for the system python3 the harness runs on.
set -eu
version="${1:?the Mountpoint for Amazon S3 version to install (build-arg MOUNTPOINT_VERSION)}"
expected="${2:?the sha256 of that version's .deb (build-arg MOUNTPOINT_SHA256)}"
boto3_version="${3:?the boto3 version the harness runs on (build-arg BOTO3_VERSION)}"
apt-get update
apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip util-linux iproute2 iptables curl
/usr/bin/python3 -m pip install --no-cache-dir --break-system-packages "boto3==${boto3_version}"
case "$(dpkg --print-architecture)" in
  arm64) arch=arm64 ;;
  amd64) arch=x86_64 ;;
  *) echo "unsupported architecture" >&2; exit 1 ;;
esac
curl -fsSLo /tmp/mount-s3.deb \
  "https://s3.amazonaws.com/mountpoint-s3-release/${version}/${arch}/mount-s3-${version}-${arch}.deb"
echo "${expected}  /tmp/mount-s3.deb" | sha256sum -c -
apt-get install -y /tmp/mount-s3.deb
rm -f /tmp/mount-s3.deb
apt-get purge -y curl
apt-get autoremove -y
rm -rf /var/lib/apt/lists/*
groupadd --gid 10000 work
useradd --create-home --uid 10001 --gid work unit
useradd --create-home --uid 10002 --gid work code
chmod 700 /home/unit
mkdir -p /work /mnt/voc-cache /opt/voc/hooks /opt/voc/cache
chown unit:work /work
# Not group-writable: `code` writes only inside the checkout (/work/repo, made by `unit` under umask 0002), never
# beside it, where the agent's own commands run.
chmod 2755 /work
# Toolchain caches (pip, npm, Maven, Gradle, cargo) live here, for `code`, which runs the dependency step. No PATH
# names a directory under it.
chown code:work /opt/voc/cache
chmod 2775 /opt/voc/cache
