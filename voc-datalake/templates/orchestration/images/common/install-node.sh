#!/bin/sh
# Node.js from its official release tarball (7.50.00), for an image whose own toolchain is another language's (the
# Python and Rust images: a repository's TypeScript half, the typescript gate pack). Run as root at build time, after
# install-base.sh.
#
# Usage: install-node.sh <version> <sha256 of node-v<version>-linux-arm64.tar.gz>
# The version and its checksum are pinned in the Dockerfile (from https://nodejs.org/dist/v<version>/SHASUMS256.txt)
# and checked: the build fails rather than install a tarball it cannot verify. The tree is root's, under /opt/node; only
# node, npm and npx are linked into /usr/local/bin, which `code` cannot write.
set -eu
version="${1:?the Node.js version to install}"
expected="${2:?the sha256 of the linux-arm64 .tar.gz of that version}"
case "$(dpkg --print-architecture)" in
  arm64) arch=arm64 ;;
  *) echo 'the Node.js tarball pinned here is for linux-arm64 (AgentCore Runtime V2 runs arm64)' >&2; exit 1 ;;
esac
apt-get update
apt-get install -y --no-install-recommends curl
curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.gz"
echo "${expected}  /tmp/node.tar.gz" | sha256sum -c -
mkdir -p /opt/node
tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 --no-same-owner
rm -f /tmp/node.tar.gz
for tool in node npm npx; do
  ln -sf "/opt/node/bin/${tool}" "/usr/local/bin/${tool}"
done
apt-get purge -y curl
apt-get autoremove -y
rm -rf /var/lib/apt/lists/*
# (no setuid or setgid file comes with it: install-base.sh's sweep holds for the whole image)
find /opt/node -xdev -type f -perm /6000 -exec chmod ug-s {} +
node --version
