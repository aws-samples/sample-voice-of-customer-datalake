#!/bin/sh
# Ready hook: warm the shared npm cache with the TypeScript gate tools so an agent starts warm.
# Reaches only the Node egress allowlist's registry (registry.npmjs.org).
set -eu
# Hooks run as root before any repository code: never from a directory a repository can write.
cd /
npm cache add typescript@5 eslint@9 vitest@3 >/dev/null
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
chown -R code:work /opt/voc/cache
