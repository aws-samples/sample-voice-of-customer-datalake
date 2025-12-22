# Artifact Builder Executor
# Runs Kiro CLI to generate web artifacts from prompts

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    zip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf aws awscliv2.zip

# Install Python dependencies for the executor script
RUN pip3 install --break-system-packages boto3

# Create workspace directory
WORKDIR /workspace

# Copy executor script
COPY executor.py /app/executor.py
COPY system_prompt.txt /app/system_prompt.txt

# Copy starter templates
COPY templates/ /app/templates/

# Set environment variables
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1

# Run the executor
CMD ["python3", "/app/executor.py"]
