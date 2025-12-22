# Artifact Builder Executor
# Uses Amazon Linux 2023 for full terminal support
# Runs Kiro CLI in headless autonomous mode to generate web artifacts from prompts
#
# Auth model: Kiro CLI uses OAuth device flow. Auth state must be persisted
# to EFS volumes mounted at runtime. First run requires manual device flow login.
#
# IMPORTANT: /home/kiro is mounted from EFS, so app files go in /app instead

FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# Install system dependencies
# Use --allowerasing to handle curl-minimal conflict
RUN dnf update -y && dnf install -y --allowerasing \
    curl \
    ca-certificates \
    git \
    bash \
    zip \
    unzip \
    jq \
    python3 \
    python3-pip \
    tar \
    gzip \
    which \
    procps-ng \
    util-linux \
    shadow-utils \
    && dnf clean all

# Install Node.js 20 LTS
RUN curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - \
    && dnf install -y nodejs \
    && dnf clean all

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# Install git-remote-codecommit for CodeCommit HTTPS access
RUN pip3 install setuptools wheel && pip3 install git-remote-codecommit boto3

# Install Kiro CLI (official installer) - installs to /root/.local/bin
RUN curl -fsSL https://cli.kiro.dev/install | bash

# Create non-root user with specific UID/GID for EFS access point
# Must match the EFS access point posixUser configuration
RUN groupadd -g 10001 kiro \
    && useradd -m -u 10001 -g 10001 -s /bin/bash kiro

# Copy Kiro CLI to a location accessible by kiro user
RUN cp -r /root/.local/bin/* /usr/local/bin/ 2>/dev/null || true

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
ENV TERM=xterm-256color
ENV SHELL=/bin/bash

WORKDIR /workspace

# Environment
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV KIRO_LOG_LEVEL=info

# Entrypoint handles auth check and runs executor
CMD ["/bin/bash", "/app/entrypoint.sh"]
# Force rebuild: 1766407772
