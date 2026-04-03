#!/bin/bash
# Build Lambda layers using Docker for Linux ARM64 (Graviton) compatibility
# This ensures native dependencies (like pydantic-core) are compiled for Lambda's ARM64 environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LAYERS_DIR="$PROJECT_ROOT/lambda/layers"

echo "Building Lambda layers using Docker (ARM64/Graviton for Lambda)..."
echo "Project root: $PROJECT_ROOT"

# Use the official AWS Lambda Python 3.14 image with ARM64 platform
DOCKER_IMAGE="public.ecr.aws/sam/build-python3.14:latest"
PLATFORM="linux/arm64"

# Build processing-deps layer
echo ""
echo "=== Building processing-deps layer ==="
PROCESSING_DEPS_DIR="$LAYERS_DIR/processing-deps"

# Clean existing python directory
rm -rf "$PROCESSING_DEPS_DIR/python"
mkdir -p "$PROCESSING_DEPS_DIR/python"

docker run --rm --platform "$PLATFORM" \
  -v "$PROCESSING_DEPS_DIR:/var/task" \
  "$DOCKER_IMAGE" \
  bash -c 'pip install --upgrade pip boto3 botocore --quiet --root-user-action=ignore && pip install -r /var/task/requirements.txt -t /var/task/python --upgrade --quiet --root-user-action=ignore'

echo "processing-deps layer built successfully"
echo "  Size: $(du -sh "$PROCESSING_DEPS_DIR/python" | cut -f1)"

# Build ingestion-deps layer if it exists
INGESTION_DEPS_DIR="$LAYERS_DIR/ingestion-deps"
if [ -f "$INGESTION_DEPS_DIR/requirements.txt" ]; then
  echo ""
  echo "=== Building ingestion-deps layer ==="

  rm -rf "$INGESTION_DEPS_DIR/python"
  mkdir -p "$INGESTION_DEPS_DIR/python"

  docker run --rm --platform "$PLATFORM" \
    -v "$INGESTION_DEPS_DIR:/var/task" \
    "$DOCKER_IMAGE" \
    bash -c 'pip install --upgrade pip boto3 botocore --quiet --root-user-action=ignore && pip install -r /var/task/requirements.txt -t /var/task/python --upgrade --quiet --root-user-action=ignore'

  echo "ingestion-deps layer built successfully"
  echo "  Size: $(du -sh "$INGESTION_DEPS_DIR/python" | cut -f1)"
fi

echo ""
echo "=== All layers built successfully ==="
echo "You can now deploy with: npx cdk deploy --all"
