#!/bin/sh
# Validate hook: the toolchain runs and the unit runner answers.
set -eu
# Hooks run as root before any repository code: never from a directory a repository can write.
cd /
node --version
npm --version
git --version
exec sh /opt/voc/hooks/check-runner.sh node -e 'console.log("ok")'
