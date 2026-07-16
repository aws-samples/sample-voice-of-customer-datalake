#!/bin/bash
# Build Lambda layers for Linux ARM64 (Graviton) compatibility.
# This ensures native dependencies (like pydantic-core) are compiled for Lambda's ARM64 environment.
#
# Container runtime: defaults to Docker, but honors the same override the CDK
# deploys already use — either of:
#   CONTAINER_CMD=finch ./scripts/build-layers.sh
#   CDK_DOCKER=finch    ./scripts/build-layers.sh
# (Finch is a drop-in replacement for `docker run` for this use case.)

set -e

CONTAINER_CMD="${CONTAINER_CMD:-${CDK_DOCKER:-docker}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LAYERS_DIR="$PROJECT_ROOT/lambda/layers"

echo "Building Lambda layers using $CONTAINER_CMD (ARM64/Graviton for Lambda)..."
echo "Project root: $PROJECT_ROOT"

# Use the official AWS Lambda Python 3.14 image with ARM64 platform
DOCKER_IMAGE="public.ecr.aws/sam/build-python3.14:latest"
PLATFORM="linux/arm64"

# Install layer deps, then strip the AWS SDK.
#
# KEPT IN LOCKSTEP with lib/utils/python-layer-bundling.ts — the CDK stacks
# re-bundle these same layers at synth time with the identical recipe. Change
# one, change both.
#
# Lambda's Python runtime PROVIDES boto3/botocore as a matched pair, but
# aws-lambda-powertools[tracer] -> aws-xray-sdk pulls botocore in
# transitively. Shipping that botocore (without boto3) is harmful:
# /opt/python precedes /var/runtime on sys.path, so the runtime's boto3
# would be paired with the layer's mismatched botocore — the exact
# incompatibility pip's resolver error warns about (issue #194). Stripping
# it also cuts ~15MB per layer. pip runs from a THROWAWAY VENV inside the
# container: the build image preinstalls boto3 in its system site-packages,
# and pip's post-install consistency check compares it against the target
# dir's botocore, printing a scary-but-irrelevant "dependency resolver"
# error on every build — a clean venv has nothing installed, so there is
# nothing to conflict with. The remaining flags silence build-image noise
# (root-user warning, unwritable-cache warning, self-update notice) that
# isn't actionable in a throwaway container.
install_layer_deps() {
  local layer_dir="$1"
  "$CONTAINER_CMD" run --rm --platform "$PLATFORM" \
    -v "$layer_dir:/var/task" \
    "$DOCKER_IMAGE" \
    sh -c "python -m venv /tmp/buildenv \
           && /tmp/buildenv/bin/pip install -r /var/task/requirements.txt -t /var/task/python \
                --upgrade --quiet --no-cache-dir --root-user-action=ignore --disable-pip-version-check \
           && rm -rf /var/task/python/boto3 /var/task/python/botocore \
                     /var/task/python/boto3-* /var/task/python/botocore-*"
}

# Build processing-deps layer
echo ""
echo "=== Building processing-deps layer ==="
PROCESSING_DEPS_DIR="$LAYERS_DIR/processing-deps"

# Clean existing python directory
rm -rf "$PROCESSING_DEPS_DIR/python"
mkdir -p "$PROCESSING_DEPS_DIR/python"

install_layer_deps "$PROCESSING_DEPS_DIR"

echo "✓ processing-deps layer built successfully"
echo "  Size: $(du -sh "$PROCESSING_DEPS_DIR/python" | cut -f1)"

# Build ingestion-deps layer if it exists
INGESTION_DEPS_DIR="$LAYERS_DIR/ingestion-deps"
if [ -f "$INGESTION_DEPS_DIR/requirements.txt" ]; then
  echo ""
  echo "=== Building ingestion-deps layer ==="
  
  rm -rf "$INGESTION_DEPS_DIR/python"
  mkdir -p "$INGESTION_DEPS_DIR/python"
  
  install_layer_deps "$INGESTION_DEPS_DIR"
  
  echo "✓ ingestion-deps layer built successfully"
  echo "  Size: $(du -sh "$INGESTION_DEPS_DIR/python" | cut -f1)"
fi

echo ""
echo "=== All layers built successfully ==="
echo "You can now deploy with: npx cdk deploy --all"
