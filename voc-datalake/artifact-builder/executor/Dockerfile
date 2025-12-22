# Artifact Builder Executor
# Runs Kiro CLI in autonomous mode to generate web artifacts from prompts

FROM node:20-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    zip \
    unzip \
    git \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (for x86_64 - change to aarch64 for ARM)
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# Install git-remote-codecommit for CodeCommit HTTPS access
RUN pip3 install --break-system-packages git-remote-codecommit boto3

# Install Kiro CLI globally
# Note: Replace with actual Kiro CLI installation when available
# For now, we'll use a placeholder that will be configured at runtime
RUN npm install -g @anthropic-ai/claude-code || true

# Create app directory
WORKDIR /app

# Copy executor script and configuration
COPY executor.py /app/executor.py
COPY kiro_prompt.txt /app/kiro_prompt.txt

# Create workspace directory for Kiro to work in
RUN mkdir -p /workspace

# Set environment variables
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV HOME=/root

# Configure git for CodeCommit
RUN git config --global credential.helper '!aws codecommit credential-helper $@' \
    && git config --global credential.UseHttpPath true \
    && git config --global user.email "artifact-builder@internal" \
    && git config --global user.name "Artifact Builder"

# Run the executor
CMD ["python3", "/app/executor.py"]
