#!/usr/bin/env bash
# build-plugin.sh — Assemble the native Amazon Quick Desktop plugin package
#
# Usage:
#   ./build-plugin.sh              # outputs dist/aidlc-discovery/ and .qplugin
#   ./build-plugin.sh my-output    # outputs dist/my-output/ and .qplugin
#
# Prerequisites: zip and rsync
# Import the generated folder through Agents & skills → Plugins → Import folder.
# Current Quick Desktop builds hang while previewing the equivalent .qplugin file.

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
PLUGIN_NAME="${1:-aidlc-discovery}"

if [[ ! "${PLUGIN_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "Plugin name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens." >&2
    exit 2
fi

OUTPUT_FILE="${SCRIPT_DIR}/dist/${PLUGIN_NAME}.qplugin"
OUTPUT_DIR="${SCRIPT_DIR}/dist/${PLUGIN_NAME}"
BUILD_ROOT="${SCRIPT_DIR}/.tmp"
SKILL_ID="quick-aidlc-discovery"

mkdir -p "${BUILD_ROOT}"
BUILD_DIR=$(mktemp -d "${BUILD_ROOT}/plugin.XXXXXX")

cleanup() {
    if [[ -n "${BUILD_DIR:-}" ]]; then
        rm -rf "${BUILD_DIR}"
    fi
}
trap cleanup EXIT

echo "Building Quick Desktop plugin: ${PLUGIN_NAME}"
echo "   Source: ${SCRIPT_DIR}"
echo "   Build:  ${BUILD_DIR}"

# 1. Copy the plugin manifest.
cp "${SCRIPT_DIR}/plugin/plugin.json" "${BUILD_DIR}/plugin.json"

# 2. Copy MCP and task configurations.
cp "${SCRIPT_DIR}/plugin/mcps.json" "${BUILD_DIR}/mcps.json"
cp "${SCRIPT_DIR}/plugin/tasks.json" "${BUILD_DIR}/tasks.json"

# 3. Copy the complete skill package without repository/build artifacts.
SKILL_DIR="${BUILD_DIR}/skills/${SKILL_ID}"
mkdir -p "${SKILL_DIR}"

EXCLUDE_PATTERNS=(
    "plugin/"
    "dist/"
    ".tmp/"
    "tests/"
    "__pycache__/"
    "*.pyc"
    "*.gitkeep"
    "build-plugin.sh"
    "build-workshop-zip.sh"
    ".git/"
    ".gitignore"
    ".DS_Store"
)

RSYNC_EXCLUDES=()
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
    RSYNC_EXCLUDES+=(--exclude="${pattern}")
done

rsync -a "${RSYNC_EXCLUDES[@]}" "${SCRIPT_DIR}/" "${SKILL_DIR}/"

# 4. Update created_at in the staged manifest when Python is available.
if command -v python3 >/dev/null 2>&1; then
    TIMESTAMP=$(python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
    python3 -c '
import json
import sys

path, timestamp = sys.argv[1:]
with open(path, "r+", encoding="utf-8") as manifest:
    data = json.load(manifest)
    data["created_at"] = timestamp
    manifest.seek(0)
    json.dump(data, manifest, indent=2)
    manifest.truncate()
' "${BUILD_DIR}/plugin.json" "${TIMESTAMP}"
    echo "   Timestamp: ${TIMESTAMP}"
fi

# 5. Create the portable archive for Quick builds where file import works.
mkdir -p "${SCRIPT_DIR}/dist"
rm -f "${OUTPUT_FILE}"
(cd "${BUILD_DIR}" && zip -r "${OUTPUT_FILE}" . -x ".*")

# 6. Retain the same staged tree for the verified Import folder workflow.
rm -rf "${OUTPUT_DIR}"
mv "${BUILD_DIR}" "${OUTPUT_DIR}"
BUILD_DIR=""

FILE_SIZE=$(du -h "${OUTPUT_FILE}" | cut -f1)
FOLDER_SIZE=$(du -sh "${OUTPUT_DIR}" | cut -f1)
echo ""
echo "Quick Desktop plugin built successfully."
echo "   Import folder: ${OUTPUT_DIR} (${FOLDER_SIZE})"
echo "   Archive:       ${OUTPUT_FILE} (${FILE_SIZE})"
echo ""
echo "Verified workflow for Quick Desktop:"
echo "   Agents & skills → Plugins → Import folder"
echo "   Select: ${OUTPUT_DIR}"
echo ""
