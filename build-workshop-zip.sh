#!/usr/bin/env bash
# build-workshop-zip.sh — Create a distributable ZIP for participants
#
# Usage:
#   ./build-workshop-zip.sh       # outputs dist/aidlc-discovery.zip
#
# Prerequisites: zip and rsync
#
# Archive layout:
#   quick-aidlc-discovery/                 complete, link-stable skill package
#       ├── WORKSHOP-SETUP.md     participant instructions
#       ├── SKILL.md
#       ├── agents/...
#       ├── architecture/...
#       └── knowledge-base/...    includes sample data
#
# Participants open quick-aidlc-discovery/WORKSHOP-SETUP.md, then copy quick-aidlc-discovery/
# into ~/.quickwork/profiles/<id>/skills/.

set -euo pipefail

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Required command not found: $1" >&2
        exit 1
    fi
}

require_command zip
require_command rsync

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/dist/aidlc-discovery.zip"
BUILD_ROOT="${SCRIPT_DIR}/.tmp"

mkdir -p "${BUILD_ROOT}"
BUILD_DIR=$(mktemp -d "${BUILD_ROOT}/workshop.XXXXXX")
SKILL_DIR="${BUILD_DIR}/quick-aidlc-discovery"

cleanup() {
    rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

echo "Building workshop ZIP..."

mkdir -p "${SCRIPT_DIR}/dist"
rm -f "${OUTPUT_FILE}"
mkdir -p "${SKILL_DIR}"

# Keep the documentation together so all relative links still work after
# extraction. Exclude only development and build artifacts.
rsync -a \
    --exclude="plugin/" \
    --exclude="dist/" \
    --exclude=".tmp/" \
    --exclude="tests/" \
    --exclude="__pycache__/" \
    --exclude="*.pyc" \
    --exclude="*.gitkeep" \
    --exclude="build-plugin.sh" \
    --exclude="build-workshop-zip.sh" \
    --exclude=".git/" \
    --exclude=".gitignore" \
    --exclude=".DS_Store" \
    "${SCRIPT_DIR}/" "${SKILL_DIR}/"

(cd "${BUILD_DIR}" && zip -r "${OUTPUT_FILE}" . -x ".*")

FILE_SIZE=$(du -h "${OUTPUT_FILE}" | cut -f1)
echo ""
echo "Workshop ZIP ready."
echo "   Output: ${OUTPUT_FILE}"
echo "   Size:   ${FILE_SIZE}"
echo ""
echo "Distribution options: email, shared drive, USB, or a presigned URL."
echo "Participants: unzip → open quick-aidlc-discovery/WORKSHOP-SETUP.md → install quick-aidlc-discovery/."
echo ""
