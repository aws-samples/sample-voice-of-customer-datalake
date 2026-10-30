#!/bin/bash
# Build Lambda layers for Linux ARM64 (Graviton) compatibility.
# This ensures native dependencies (like pydantic-core) are compiled for Lambda's ARM64 environment.
#
# Container runtime: defaults to Docker, but honors the same override the CDK
# deploys already use — either of:
#   CONTAINER_CMD=finch ./scripts/build-layers.sh
#   CDK_DOCKER=finch    ./scripts/build-layers.sh
# (Finch is a drop-in replacement for `docker run` for this use case.)
#
# Unchanged layers are skipped: each built layer gets a stamp file
# (<layer>/.build-stamp, gitignored, excluded from the CDK asset) holding a
# SHA-256 of everything that determines the build — the layer's
# requirements*.txt, the install recipe below, the build image (Python
# version) and the platform. Same hash and a built python/ dir → the layer is
# skipped with one log line. A missing or unreadable stamp rebuilds. Force a
# full rebuild with either of:
#   FORCE_LAYER_BUILD=1 ./scripts/build-layers.sh
#   ./scripts/build-layers.sh --force
# (The `:latest` image tag can move without the hash changing; force a rebuild
# after pulling a new build image.)

set -e

CONTAINER_CMD="${CONTAINER_CMD:-${CDK_DOCKER:-docker}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# LAYERS_DIR is overridable for lib/utils/build-layers-script.test.ts only.
LAYERS_DIR="${LAYERS_DIR:-$PROJECT_ROOT/lambda/layers}"
STAMP_NAME=".build-stamp"
# Bump to invalidate every stamp when the stamp format itself changes.
STAMP_FORMAT="1"

FORCE="${FORCE_LAYER_BUILD:-0}"
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "Unknown argument: $arg (supported: --force)" >&2; exit 2 ;;
  esac
done

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

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1
  fi
}

# The build hash of one layer: stamp format, image, platform, the recipe
# (install_layer_deps as bash prints it) and every requirements*.txt (name +
# content, in sorted order).
layer_build_hash() {
  local layer_dir="$1" req
  {
    echo "format=$STAMP_FORMAT"
    echo "image=$DOCKER_IMAGE"
    echo "platform=$PLATFORM"
    declare -f install_layer_deps
    for req in "$layer_dir"/requirements*.txt; do
      [ -f "$req" ] || continue
      echo "file=$(basename "$req")"
      cat "$req"
    done
  } | sha256_stdin
}

# True when the layer was built from exactly this hash and its output is there.
layer_is_current() {
  local layer_dir="$1" want="$2" have
  [ "$FORCE" = "1" ] && return 1
  [ -d "$layer_dir/python" ] || return 1
  [ -f "$layer_dir/$STAMP_NAME" ] || return 1
  have="$(head -n 1 "$layer_dir/$STAMP_NAME" 2>/dev/null || true)"
  [ "$have" = "$want" ]
}

# Every layer dir with a requirements.txt (processing-deps, ingestion-deps,
# signing-deps, email-intake-deps: lib/utils/dependency-layers.ts).
for layer_dir in "$LAYERS_DIR"/*/; do
  layer_dir="${layer_dir%/}"
  [ -f "$layer_dir/requirements.txt" ] || continue
  name="$(basename "$layer_dir")"
  hash="$(layer_build_hash "$layer_dir")"
  if layer_is_current "$layer_dir" "$hash"; then
    echo "= $name layer unchanged (build hash ${hash:0:12}), skipped; FORCE_LAYER_BUILD=1 rebuilds"
    continue
  fi
  echo ""
  echo "=== Building $name layer ==="
  # The stamp goes first, so a failed build never leaves a stamp claiming success.
  rm -f "$layer_dir/$STAMP_NAME"
  rm -rf "$layer_dir/python"
  mkdir -p "$layer_dir/python"
  install_layer_deps "$layer_dir"
  echo "$hash" > "$layer_dir/$STAMP_NAME"
  echo "✓ $name layer built successfully"
  echo "  Size: $(du -sh "$layer_dir/python" | cut -f1)"
done

echo ""
echo "=== All layers built (or already current) ==="
echo "You can now deploy with: npx cdk deploy --all"
