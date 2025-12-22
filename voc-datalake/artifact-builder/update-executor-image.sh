#!/bin/bash
# Update the executor image with new code while preserving Kiro CLI auth
#
# Usage: ./update-executor-image.sh
#
# This script:
# 1. Builds a new base image with updated code
# 2. Copies auth from the existing with-auth image
# 3. Pushes the updated image to ECR

set -e

REGION="us-west-2"
ACCOUNT_ID="512144631813"
ECR_REPO="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/artifact-builder-executor"

echo "=== Building new base image ==="
docker build -t artifact-builder-executor:latest executor/

echo ""
echo "=== Creating updated image with auth ==="

# Create a temporary directory for auth files
rm -rf /tmp/kiro-auth-transfer
mkdir -p /tmp/kiro-auth-transfer

# Extract auth files from the existing authenticated image
echo "Extracting auth from existing image..."
docker run --rm -v /tmp/kiro-auth-transfer:/transfer artifact-builder-executor:with-auth \
  bash -c "cp -r /home/kiro/.aws /transfer/ 2>/dev/null || true; \
           cp -r /home/kiro/.kiro /transfer/ 2>/dev/null || true; \
           cp -r /home/kiro/.config /transfer/ 2>/dev/null || true; \
           cp -r /home/kiro/.local /transfer/ 2>/dev/null || true; \
           ls -la /transfer/"

# Start a container from the new image and copy auth into it
echo ""
echo "Injecting auth into new image..."
CONTAINER_ID=$(docker run -d artifact-builder-executor:latest sleep 300)

# Copy auth files into the container
docker cp /tmp/kiro-auth-transfer/.aws $CONTAINER_ID:/home/kiro/.aws 2>/dev/null || true
docker cp /tmp/kiro-auth-transfer/.kiro $CONTAINER_ID:/home/kiro/.kiro 2>/dev/null || true
docker cp /tmp/kiro-auth-transfer/.config $CONTAINER_ID:/home/kiro/.config 2>/dev/null || true
docker cp /tmp/kiro-auth-transfer/.local $CONTAINER_ID:/home/kiro/.local 2>/dev/null || true

# Fix ownership
docker exec $CONTAINER_ID bash -c "chown -R kiro:kiro /home/kiro/" 2>/dev/null || true

# Commit the container as the new with-auth image
echo "Committing new image..."
docker commit $CONTAINER_ID artifact-builder-executor:with-auth

# Cleanup
docker stop $CONTAINER_ID
docker rm $CONTAINER_ID
rm -rf /tmp/kiro-auth-transfer

echo ""
echo "=== Verifying auth ==="
docker run --rm artifact-builder-executor:with-auth bash -c "kiro-cli whoami"

echo ""
echo "=== Pushing to ECR ==="
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

docker tag artifact-builder-executor:with-auth $ECR_REPO:with-auth
docker push $ECR_REPO:with-auth

echo ""
echo "=== Done ==="
echo "Image pushed: $ECR_REPO:with-auth"
