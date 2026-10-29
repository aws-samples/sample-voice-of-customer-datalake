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

# Install layer deps, then strip what the runtime ships and what never runs.
#
# KEPT IN LOCKSTEP with lib/utils/python-layer-bundling.ts — the CDK stacks
# re-bundle these same layers at synth time with the identical recipe.
# lib/utils/python-layer-bundling.test.ts fails if the two copies drift (the
# strip line below must equal layerStripSteps('/var/task/python')).
#
# Lambda's Python runtime PROVIDES the AWS SDK closure (boto3, botocore,
# s3transfer, jmespath, python-dateutil, six, urllib3), but
# aws-lambda-powertools[tracer] -> aws-xray-sdk pulls botocore and its
# dependencies in transitively. Shipping them is harmful: /opt/python precedes
# the runtime's site-packages on sys.path, so the runtime's boto3 would be
# paired with the layer's mismatched botocore (issue #194), and botocore would
# run on the layer's urllib3. bin/ (console scripts), *.pyi / *-stubs (type
# stubs) and packaged tests/ never run in Lambda. LAYER_STRIP in the .ts
# documents each entry. pip runs from a THROWAWAY VENV inside the container:
# the build image preinstalls boto3 in its system site-packages, and pip's
# post-install consistency check compares it against the target dir's
# botocore, printing a scary-but-irrelevant "dependency resolver" error on
# every build — a clean venv has nothing installed, so there is nothing to
# conflict with. The remaining flags silence build-image noise (root-user
# warning, unwritable-cache warning, self-update notice) that isn't actionable
# in a throwaway container.
install_layer_deps() {
  local layer_dir="$1"
  "$CONTAINER_CMD" run --rm --platform "$PLATFORM" \
    -v "$layer_dir:/var/task" \
    "$DOCKER_IMAGE" \
    sh -c 'venv="$(mktemp -d)" \
           && python -m venv "$venv" \
           && "$venv"/bin/pip install -r /var/task/requirements.txt -t /var/task/python \
                --upgrade --quiet --no-cache-dir --root-user-action=ignore --disable-pip-version-check \
           && rm -rf /var/task/python/boto3 /var/task/python/boto3-* /var/task/python/botocore /var/task/python/botocore-* /var/task/python/s3transfer /var/task/python/s3transfer-* /var/task/python/jmespath /var/task/python/jmespath-* /var/task/python/dateutil /var/task/python/python_dateutil-* /var/task/python/six.py /var/task/python/six-* /var/task/python/urllib3 /var/task/python/urllib3-* /var/task/python/bin /var/task/python/*-stubs && find /var/task/python -name "*.pyi" -type f -delete && find /var/task/python -mindepth 2 -type d -name tests -prune -exec rm -rf {} +'
}

# Every layer dir with a requirements.txt (processing-deps, ingestion-deps,
# signing-deps, email-intake-deps: lib/utils/dependency-layers.ts).
for layer_dir in "$LAYERS_DIR"/*/; do
  layer_dir="${layer_dir%/}"
  [ -f "$layer_dir/requirements.txt" ] || continue
  name="$(basename "$layer_dir")"
  echo ""
  echo "=== Building $name layer ==="
  rm -rf "$layer_dir/python"
  mkdir -p "$layer_dir/python"
  install_layer_deps "$layer_dir"
  echo "✓ $name layer built successfully"
  echo "  Size: $(du -sh "$layer_dir/python" | cut -f1)"
done

echo ""
echo "=== All layers built successfully ==="
echo "You can now deploy with: npx cdk deploy --all"
