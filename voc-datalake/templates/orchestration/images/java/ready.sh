#!/bin/sh
# Ready hook: warm the shared Maven repository with the plugins every build resolves first.
# Reaches only the Java egress allowlist (repo.maven.apache.org, repo1.maven.org).
set -eu
# Hooks run as root before any repository code: never from a directory a repository can write.
cd /
mvn --batch-mode --quiet dependency:get -Dartifact=org.apache.maven.plugins:maven-surefire-plugin:3.5.2
mvn --batch-mode --quiet dependency:get -Dartifact=org.apache.maven.plugins:maven-compiler-plugin:3.13.0
chown -R code:work /opt/voc/cache
