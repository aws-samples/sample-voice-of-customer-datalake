#!/usr/bin/env bash
set -euo pipefail

echo "=== Artifact Builder Executor ==="
echo "Job ID: ${JOB_ID:-not set}"
echo "AWS Region: ${AWS_REGION:-not set}"
echo "HOME: $HOME"

# Ensure auth directories exist in EFS-mounted home
mkdir -p "$HOME/.kiro" "$HOME/.config/kiro" "$HOME/.local/share/kiro-cli"

# Configure git for CodeCommit (must be done at runtime since HOME is EFS-mounted)
git config --global credential.helper '!aws codecommit credential-helper $@'
git config --global credential.UseHttpPath true
git config --global user.email "artifact-builder@internal"
git config --global user.name "Artifact Builder"

# Check if Kiro CLI is authenticated
echo "Checking Kiro CLI authentication..."
if kiro-cli whoami >/dev/null 2>&1; then
    echo "✓ Kiro CLI authenticated"
    kiro-cli whoami
else
    echo "✗ Kiro CLI not authenticated"
    echo ""
    echo "ERROR: Kiro CLI requires authentication via device flow."
    echo ""
    echo "To authenticate, run this container interactively:"
    echo "  kiro-cli login --use-device-flow"
    echo ""
    echo "Follow the instructions to complete login in your browser."
    echo "The auth state will persist in EFS for future task runs."
    echo ""
    
    # If we're in interactive mode (sleep command), don't exit
    if [[ "${1:-}" == "/bin/bash" ]] || [[ "${1:-}" == "bash" ]] || [[ "${1:-}" == "sleep"* ]]; then
        echo "Running in interactive mode - starting shell..."
        exec "$@"
    fi
    
    exit 1
fi

# Run the Python executor
echo ""
echo "Starting artifact generation..."
exec python3 /app/executor.py "$@"
