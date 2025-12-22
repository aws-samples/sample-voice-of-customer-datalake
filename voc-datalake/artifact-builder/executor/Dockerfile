# Artifact Builder Executor
# Runs Kiro CLI in headless autonomous mode to generate web artifacts from prompts
# 
# Auth model: Kiro CLI uses OAuth device flow. Auth state must be persisted
# to EFS volumes mounted at runtime. First run requires manual device flow login.

FROM ubuntu:24.04

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    bash \
    zip \
    unzip \
    jq \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (x86_64)
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# Install git-remote-codecommit for CodeCommit HTTPS access
RUN pip3 install --break-system-packages git-remote-codecommit boto3

# Install Kiro CLI (official installer)
RUN curl -fsSL https://cli.kiro.dev/install | bash

# Create non-root user with specific UID/GID for EFS access point
# Must match the EFS access point posixUser configuration
RUN groupadd -g 10001 kiro \
    && useradd -m -u 10001 -g 10001 kiro

# Create app directory and copy files (as root)
WORKDIR /home/kiro/app
COPY executor.py /home/kiro/app/executor.py
COPY kiro_prompt.txt /home/kiro/app/kiro_prompt.txt
COPY entrypoint.sh /home/kiro/app/entrypoint.sh
RUN chmod +x /home/kiro/app/entrypoint.sh

# Create workspace directory
RUN mkdir -p /home/kiro/workspace

# Set ownership
RUN chown -R kiro:kiro /home/kiro

# Switch to non-root user
USER kiro
ENV HOME=/home/kiro
ENV PATH="/home/kiro/.local/bin:/root/.local/bin:$PATH"

# Create directories for Kiro CLI (will be overlaid by EFS mount)
RUN mkdir -p \
    /home/kiro/.kiro \
    /home/kiro/.config/kiro \
    /home/kiro/.local/share/kiro-cli

WORKDIR /home/kiro/workspace

# Configure git for CodeCommit (will use IAM role credentials)
RUN git config --global credential.helper '!aws codecommit credential-helper $@' \
    && git config --global credential.UseHttpPath true \
    && git config --global user.email "artifact-builder@internal" \
    && git config --global user.name "Artifact Builder"

# Environment
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV KIRO_LOG_LEVEL=info

# Entrypoint handles auth check and runs executor
ENTRYPOINT ["/home/kiro/app/entrypoint.sh"]
