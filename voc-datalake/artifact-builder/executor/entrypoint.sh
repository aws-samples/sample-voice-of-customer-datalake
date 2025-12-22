#!/usr/bin/env bash
set -euo pipefail

# Maximum execution time: 30 minutes (1800 seconds)
# This prevents runaway tasks from running indefinitely
MAX_EXECUTION_TIME=${MAX_EXECUTION_TIME:-1800}

echo "=========================================="
echo "=== Artifact Builder Executor Starting ==="
echo "=========================================="
echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Job ID: ${JOB_ID:-not set}"
echo "AWS Region: ${AWS_REGION:-not set}"
echo "Max Execution Time: ${MAX_EXECUTION_TIME}s"
echo "HOME: $HOME"
echo "PWD: $(pwd)"
echo ""

echo "[1/4] Configuring git for CodeCommit..."
git config --global credential.helper '!aws codecommit credential-helper $@'
git config --global credential.UseHttpPath true
git config --global user.email "artifact-builder@internal"
git config --global user.name "Artifact Builder"
echo "✓ Git configured"
echo ""

echo "[2/4] Checking AWS credentials..."
if aws sts get-caller-identity > /dev/null 2>&1; then
    echo "✓ AWS credentials valid"
    aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null || true
else
    echo "✗ AWS credentials not available"
fi
echo ""

echo "[3/4] Checking Kiro CLI authentication..."
echo "Running: kiro-cli whoami (with 15s timeout)"
if timeout 15 kiro-cli whoami 2>&1; then
    echo "✓ Kiro CLI authenticated and ready"
else
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo "⚠ Kiro CLI auth check timed out after 15s"
    else
        echo "⚠ Kiro CLI auth check failed (exit code: $EXIT_CODE)"
    fi
    echo "  Continuing anyway - auth may still work during execution"
fi
echo ""

echo "[4/4] Starting Python executor..."
echo "Running: timeout ${MAX_EXECUTION_TIME}s python3 /app/executor.py"
echo "=========================================="
echo ""

# Run executor with timeout to prevent runaway tasks
exec timeout --signal=TERM --kill-after=60 ${MAX_EXECUTION_TIME} python3 /app/executor.py "$@"
