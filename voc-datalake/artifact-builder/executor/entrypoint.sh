#!/usr/bin/env bash
set -euo pipefail

echo "=== Artifact Builder Executor ==="
echo "Job ID: ${JOB_ID:-not set}"
echo "AWS Region: ${AWS_REGION:-not set}"

# Ensure auth directories exist (should be mounted as EFS volumes)
mkdir -p "$HOME/.kiro" "$HOME/.config/kiro" "$HOME/.local/share/kiro-cli"

# Check if Kiro CLI is authenticated
echo "Checking Kiro CLI authentication..."
if kiro-cli whoami >/dev/null 2>&1; then
    echo "✓ Kiro CLI authenticated"
    kiro-cli whoami
else
    echo "✗ Kiro CLI not authenticated"
    echo ""
    echo "ERROR: Kiro CLI requires authentication via device flow."
    echo "To authenticate, run this container interactively once:"
    echo ""
    echo "  docker run -it \\"
    echo "    -v kiro_dotkiro:/home/kiro/.kiro \\"
    echo "    -v kiro_config:/home/kiro/.config/kiro \\"
    echo "    -v kiro_data:/home/kiro/.local/share/kiro-cli \\"
    echo "    <image> /bin/bash"
    echo ""
    echo "  Then inside the container:"
    echo "    kiro-cli login --use-device-flow"
    echo ""
    echo "  Follow the device flow instructions to complete login."
    echo "  The auth state will persist in the mounted volumes."
    echo ""
    echo "For ECS Fargate, mount these paths to EFS and run the login once."
    exit 1
fi

# Run the Python executor
echo ""
echo "Starting artifact generation..."
exec python3 /home/kiro/app/executor.py "$@"
