# Artifact Builder Executor
# Runs Kiro CLI in headless autonomous mode to generate web artifacts from prompts
# 
# Auth model: Kiro CLI uses OAuth device flow. Auth state must be persisted
# to EFS volumes mounted at runtime. First run requires manual device flow login.
#
# IMPORTANT: /home/kiro is mounted from EFS, so app files go in /app instead

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

# Install Kiro CLI (official installer) - installs to /root/.local/bin
RUN curl -fsSL https://cli.kiro.dev/install | bash

# Create non-root user with specific UID/GID for EFS access point
# Must match the EFS access point posixUser configuration
RUN groupadd -g 10001 kiro \
    && useradd -m -u 10001 -g 10001 kiro

# Copy Kiro CLI to a location accessible by kiro user
RUN cp -r /root/.local/bin/* /usr/local/bin/ || true

# Create app directory OUTSIDE of /home/kiro (which will be EFS-mounted)
WORKDIR /app
COPY executor.py /app/executor.py
COPY kiro_prompt.txt /app/kiro_prompt.txt
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create workspace directory (also outside EFS mount)
RUN mkdir -p /workspace && chown kiro:kiro /workspace

# Set ownership of app dir
RUN chown -R kiro:kiro /app

# Switch to non-root user
USER kiro
ENV HOME=/home/kiro
ENV PATH="/usr/local/bin:$PATH"

WORKDIR /workspace

# Configure git for CodeCommit (will use IAM role credentials)
# Note: git config is stored in /home/kiro which is EFS-mounted
# So we configure it at runtime in entrypoint.sh instead

# Environment
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV KIRO_LOG_LEVEL=info

# Entrypoint handles auth check and runs executor
# Use bash directly to avoid exec format issues
CMD ["/bin/bash", "/app/entrypoint.sh"]
