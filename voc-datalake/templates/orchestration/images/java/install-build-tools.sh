#!/bin/sh
# Maven and Gradle from their release archives (7.50.00), pinned to the java gate pack's [image] versions
# (templates/orchestration/gates/java). Run as root at build time, after install-base.sh.
#
# Usage: install-build-tools.sh <maven version> <sha512 of apache-maven-<v>-bin.tar.gz> <gradle version> \
#          <sha256 of gradle-<v>-bin.zip>
# The versions and their checksums are pinned in the Dockerfile (Maven's from the release's .sha512 on
# archive.apache.org, Gradle's from its .sha256 on services.gradle.org) and checked: the build fails rather than install
# an archive it cannot verify. Both trees are root's, under /opt; only mvn and gradle are linked into /usr/local/bin,
# which `code` cannot write.
set -eu
maven="${1:?the Maven version}"
maven_sha512="${2:?the sha512 of the bin.tar.gz of that Maven version}"
gradle="${3:?the Gradle version}"
gradle_sha256="${4:?the sha256 of the bin.zip of that Gradle version}"
apt-get update
apt-get install -y --no-install-recommends curl unzip
curl -fsSLo /tmp/maven.tar.gz \
  "https://archive.apache.org/dist/maven/maven-3/${maven}/binaries/apache-maven-${maven}-bin.tar.gz"
echo "${maven_sha512}  /tmp/maven.tar.gz" | sha512sum -c -
mkdir -p /opt/maven
tar -xzf /tmp/maven.tar.gz -C /opt/maven --strip-components=1 --no-same-owner
curl -fsSLo /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${gradle}-bin.zip"
echo "${gradle_sha256}  /tmp/gradle.zip" | sha256sum -c -
unzip -q /tmp/gradle.zip -d /opt
mv "/opt/gradle-${gradle}" /opt/gradle
rm -f /tmp/maven.tar.gz /tmp/gradle.zip
ln -sf /opt/maven/bin/mvn /usr/local/bin/mvn
ln -sf /opt/gradle/bin/gradle /usr/local/bin/gradle
apt-get purge -y curl unzip
apt-get autoremove -y
rm -rf /var/lib/apt/lists/*
# (no setuid or setgid file comes with them: install-base.sh's sweep holds for the whole image)
find /opt/maven /opt/gradle -xdev -type f -perm /6000 -exec chmod ug-s {} +
mvn --version
gradle --version
