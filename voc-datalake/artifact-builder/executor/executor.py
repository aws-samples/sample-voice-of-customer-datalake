#!/usr/bin/env python3
"""
Artifact Builder Executor

Runs inside ECS Fargate to:
1. Pull job request from S3
2. Clone read-only template from CodeCommit
3. Run Kiro CLI in autonomous mode to generate code
4. Build the project
5. Create new CodeCommit repo with the result
6. Upload artifacts to S3
7. Update job status in DynamoDB

Credentials are stored in SSM Parameter Store.
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import boto3

# AWS Clients
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
ssm = boto3.client('ssm')
codecommit = boto3.client('codecommit')

# Configuration from environment
JOB_ID = os.environ.get('JOB_ID', '')
ARTIFACTS_BUCKET = os.environ.get('ARTIFACTS_BUCKET', '')
JOBS_TABLE = os.environ.get('JOBS_TABLE', 'artifact-builder-jobs')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
TEMPLATE_REPO_NAME = os.environ.get('TEMPLATE_REPO_NAME', 'artifact-builder-template')

# SSM Parameter paths
SSM_PREFIX = '/artifact-builder'

# Paths
WORKSPACE = Path('/workspace')
TEMPLATE_DIR = WORKSPACE / 'template'
PROJECT_DIR = WORKSPACE / 'project'
KIRO_PROMPT_FILE = Path('/app/kiro_prompt.txt')

jobs_table = dynamodb.Table(JOBS_TABLE)
logs = []


def log(message: str):
    """Log message and store for upload."""
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] {message}"
    print(line, flush=True)
    logs.append(line)


def update_status(status: str, error: str = None, summary: dict = None, 
                  repo_url: str = None, preview_url: str = None):
    """Update job status in DynamoDB."""
    now = datetime.now(timezone.utc).isoformat()
    
    update_expr = 'SET #status = :status, updated_at = :now'
    expr_values = {':status': status, ':now': now}
    expr_names = {'#status': 'status'}
    
    # Append to timeline
    update_expr += ', timeline = list_append(if_not_exists(timeline, :empty), :timeline)'
    expr_values[':empty'] = []
    expr_values[':timeline'] = [{'status': status, 'timestamp': now}]
    
    if error:
        update_expr += ', error = :error'
        expr_values[':error'] = error
    
    if summary:
        update_expr += ', summary = :summary'
        expr_values[':summary'] = summary
    
    if repo_url:
        update_expr += ', repo_url = :repo_url'
        expr_values[':repo_url'] = repo_url
    
    if preview_url:
        update_expr += ', preview_url = :preview_url'
        expr_values[':preview_url'] = preview_url
    
    jobs_table.update_item(
        Key={'pk': f'JOB#{JOB_ID}', 'sk': 'META'},
        UpdateExpression=update_expr,
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def upload_logs():
    """Upload logs to S3."""
    log_content = '\n'.join(logs)
    s3.put_object(
        Bucket=ARTIFACTS_BUCKET,
        Key=f'jobs/{JOB_ID}/logs.txt',
        Body=log_content,
        ContentType='text/plain'
    )


def get_ssm_parameter(name: str, decrypt: bool = True) -> Optional[str]:
    """Get parameter from SSM Parameter Store."""
    try:
        response = ssm.get_parameter(
            Name=f'{SSM_PREFIX}/{name}',
            WithDecryption=decrypt
        )
        return response['Parameter']['Value']
    except ssm.exceptions.ParameterNotFound:
        log(f"SSM parameter not found: {SSM_PREFIX}/{name}")
        return None
    except Exception as e:
        log(f"Error getting SSM parameter {name}: {e}")
        return None


def get_job_request() -> dict:
    """Download job request from S3."""
    response = s3.get_object(
        Bucket=ARTIFACTS_BUCKET,
        Key=f'jobs/{JOB_ID}/request.json'
    )
    return json.loads(response['Body'].read().decode('utf-8'))


def clone_template_repo():
    """Clone the read-only template repository from CodeCommit."""
    log(f"Cloning template repository: {TEMPLATE_REPO_NAME}")
    
    # Use git-remote-codecommit for authentication
    repo_url = f'codecommit::{AWS_REGION}://{TEMPLATE_REPO_NAME}'
    
    result = subprocess.run(
        ['git', 'clone', repo_url, str(TEMPLATE_DIR)],
        capture_output=True,
        text=True,
        timeout=120
    )
    
    if result.returncode != 0:
        log(f"Git clone stderr: {result.stderr}")
        raise Exception(f"Failed to clone template: {result.stderr}")
    
    log(f"Template cloned successfully to {TEMPLATE_DIR}")
    
    # Copy template to project directory (we'll work here)
    shutil.copytree(TEMPLATE_DIR, PROJECT_DIR, dirs_exist_ok=True)
    
    # Remove .git from project dir - we'll create a fresh repo
    git_dir = PROJECT_DIR / '.git'
    if git_dir.exists():
        shutil.rmtree(git_dir)
    
    log(f"Project directory prepared at {PROJECT_DIR}")


def create_output_repo(job_id: str) -> str:
    """Create a new CodeCommit repository for the output."""
    repo_name = f'artifact-{job_id}'
    
    log(f"Creating output repository: {repo_name}")
    
    try:
        response = codecommit.create_repository(
            repositoryName=repo_name,
            repositoryDescription=f'Generated artifact for job {job_id}',
            tags={
                'artifact-builder': 'true',
                'job-id': job_id,
            }
        )
        
        clone_url = response['repositoryMetadata']['cloneUrlHttp']
        log(f"Created repository: {clone_url}")
        return repo_name
        
    except codecommit.exceptions.RepositoryNameExistsException:
        log(f"Repository {repo_name} already exists, reusing")
        return repo_name


def build_kiro_prompt(request: dict) -> str:
    """Build the prompt to send to Kiro CLI."""
    base_prompt = KIRO_PROMPT_FILE.read_text() if KIRO_PROMPT_FILE.exists() else ""
    
    prompt = request.get('prompt', '')
    project_type = request.get('project_type', 'react-vite')
    style = request.get('style', 'minimal')
    pages = request.get('pages', [])
    features = request.get('features', [])
    include_mock_data = request.get('include_mock_data', False)
    
    user_prompt = f"""{base_prompt}

## User Request

{prompt}

## Configuration

- Project type: {project_type}
- Style preferences: {style}
"""
    
    if pages:
        user_prompt += f"- Pages/routes to create: {', '.join(pages)}\n"
    
    if features:
        user_prompt += f"- Features to include: {', '.join(features)}\n"
    
    if include_mock_data:
        user_prompt += "- Include realistic mock data for demonstration\n"
    
    user_prompt += """
## Instructions

1. Analyze the existing template structure
2. Create or modify files to implement the user's request
3. Ensure the project builds successfully with `npm run build`
4. Keep the design clean and responsive
5. Use the existing shadcn/ui components where appropriate
"""
    
    return user_prompt


def run_kiro_cli(prompt: str) -> bool:
    """Run Kiro CLI in autonomous mode with all tools allowed."""
    log("Starting Kiro CLI in autonomous mode...")
    
    # Write prompt to a file for Kiro to read
    prompt_file = PROJECT_DIR / '.kiro-prompt.md'
    prompt_file.write_text(prompt)
    
    # Get Kiro API key from SSM
    kiro_api_key = get_ssm_parameter('kiro-api-key')
    if not kiro_api_key or kiro_api_key == 'PLACEHOLDER_SET_AFTER_DEPLOY':
        raise Exception("Kiro API key not configured in SSM. Set /artifact-builder/kiro-api-key")
    
    env = os.environ.copy()
    env['ANTHROPIC_API_KEY'] = kiro_api_key
    
    # Run Kiro CLI in autonomous mode with all tools allowed
    # Adjust command based on actual Kiro CLI interface
    cmd = [
        'kiro',
        '--autonomous',
        '--allow-all-tools',
        '--prompt-file', str(prompt_file),
        '--workspace', str(PROJECT_DIR),
    ]
    
    log(f"Running: {' '.join(cmd)}")
    
    try:
        result = subprocess.run(
            cmd,
            cwd=PROJECT_DIR,
            capture_output=True,
            text=True,
            timeout=900,  # 15 minute timeout for complex generations
            env=env,
        )
        
        if result.stdout:
            log(f"Kiro stdout:\n{result.stdout[:10000]}")
        if result.stderr:
            log(f"Kiro stderr:\n{result.stderr[:5000]}")
        
        # Clean up prompt file
        prompt_file.unlink(missing_ok=True)
        
        if result.returncode != 0:
            log(f"Kiro CLI exited with code {result.returncode}")
            raise Exception(f"Kiro CLI failed with exit code {result.returncode}")
        
        return True
        
    except subprocess.TimeoutExpired:
        log("Kiro CLI timed out after 15 minutes")
        raise Exception("Kiro CLI timed out")
    except FileNotFoundError:
        log("ERROR: Kiro CLI not found. Ensure 'kiro' is installed in the container.")
        raise Exception("Kiro CLI not installed")


def run_command(cmd: list, cwd: Path = None, timeout: int = 300) -> tuple[int, str, str]:
    """Run a shell command and return exit code, stdout, stderr."""
    log(f"Running: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        cwd=cwd or PROJECT_DIR,
        capture_output=True,
        text=True,
        timeout=timeout
    )
    if result.stdout:
        log(f"stdout: {result.stdout[:2000]}")
    if result.stderr:
        log(f"stderr: {result.stderr[:1000]}")
    return result.returncode, result.stdout, result.stderr


def install_dependencies() -> bool:
    """Run npm install."""
    log("Installing dependencies...")
    code, _, _ = run_command(['npm', 'install'], timeout=300)
    return code == 0


def build_project() -> bool:
    """Run npm run build."""
    log("Building project...")
    code, _, _ = run_command(['npm', 'run', 'build'], timeout=300)
    return code == 0


def push_to_codecommit(repo_name: str) -> str:
    """Initialize git repo and push to CodeCommit."""
    log(f"Pushing to CodeCommit repository: {repo_name}")
    
    # Initialize git repo
    run_command(['git', 'init'])
    run_command(['git', 'add', '-A'])
    run_command(['git', 'commit', '-m', f'Generated artifact for job {JOB_ID}'])
    
    # Add remote and push
    repo_url = f'codecommit::{AWS_REGION}://{repo_name}'
    run_command(['git', 'remote', 'add', 'origin', repo_url])
    
    code, _, stderr = run_command(['git', 'push', '-u', 'origin', 'main', '--force'])
    
    if code != 0:
        # Try with master branch
        run_command(['git', 'branch', '-M', 'master'])
        code, _, _ = run_command(['git', 'push', '-u', 'origin', 'master', '--force'])
    
    # Return HTTPS clone URL
    return f'https://git-codecommit.{AWS_REGION}.amazonaws.com/v1/repos/{repo_name}'


def create_source_zip() -> Path:
    """Create a zip of the source code."""
    zip_path = WORKSPACE / 'source.zip'
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_path in PROJECT_DIR.rglob('*'):
            if file_path.is_file():
                rel_path = file_path.relative_to(PROJECT_DIR)
                # Skip node_modules and dist
                if 'node_modules' in str(rel_path):
                    continue
                if str(rel_path).startswith('dist/'):
                    continue
                zf.write(file_path, rel_path)
    
    log("Created source.zip")
    return zip_path


def upload_artifacts(repo_url: str) -> dict:
    """Upload all artifacts to S3."""
    log("Uploading artifacts to S3...")
    
    # Upload source.zip
    source_zip = create_source_zip()
    s3.upload_file(
        str(source_zip),
        ARTIFACTS_BUCKET,
        f'jobs/{JOB_ID}/source.zip'
    )
    log("Uploaded source.zip")
    
    # Upload build output (dist folder)
    dist_dir = PROJECT_DIR / 'dist'
    files_uploaded = []
    
    if dist_dir.exists():
        for file_path in dist_dir.rglob('*'):
            if file_path.is_file():
                rel_path = file_path.relative_to(dist_dir)
                s3_key = f'jobs/{JOB_ID}/build/{rel_path}'
                
                # Set content type
                content_type = 'application/octet-stream'
                suffix = file_path.suffix.lower()
                content_types = {
                    '.html': 'text/html',
                    '.css': 'text/css',
                    '.js': 'application/javascript',
                    '.json': 'application/json',
                    '.svg': 'image/svg+xml',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.ico': 'image/x-icon',
                    '.woff': 'font/woff',
                    '.woff2': 'font/woff2',
                }
                content_type = content_types.get(suffix, content_type)
                
                s3.upload_file(
                    str(file_path),
                    ARTIFACTS_BUCKET,
                    s3_key,
                    ExtraArgs={'ContentType': content_type}
                )
                files_uploaded.append(str(rel_path))
        
        log(f"Uploaded {len(files_uploaded)} build files")
    
    # Create summary
    summary = {
        'job_id': JOB_ID,
        'repo_url': repo_url,
        'files_uploaded': files_uploaded,
        'build_output': 'dist',
        'completed_at': datetime.now(timezone.utc).isoformat(),
    }
    
    s3.put_object(
        Bucket=ARTIFACTS_BUCKET,
        Key=f'jobs/{JOB_ID}/summary.json',
        Body=json.dumps(summary, indent=2),
        ContentType='application/json'
    )
    log("Uploaded summary.json")
    
    return summary


def main():
    """Main executor flow."""
    if not JOB_ID:
        print("ERROR: JOB_ID environment variable not set")
        sys.exit(1)
    
    log(f"Starting artifact generation for job {JOB_ID}")
    log(f"AWS Region: {AWS_REGION}")
    log(f"Template repo: {TEMPLATE_REPO_NAME}")
    
    repo_url = None
    preview_url = None
    
    try:
        # Get job request
        request = get_job_request()
        log(f"Got request: {request.get('prompt', '')[:100]}...")
        
        # Clone template from CodeCommit
        update_status('cloning')
        clone_template_repo()
        
        # Build Kiro prompt
        kiro_prompt = build_kiro_prompt(request)
        
        # Run Kiro CLI to generate code (no fallback - must succeed)
        update_status('generating')
        run_kiro_cli(kiro_prompt)
        
        # Install dependencies
        update_status('building')
        if not install_dependencies():
            raise Exception("npm install failed")
        
        # Build the project
        max_retries = 2
        for attempt in range(max_retries):
            if build_project():
                break
            log(f"Build failed, attempt {attempt + 1}/{max_retries}")
            if attempt < max_retries - 1:
                # Ask Kiro to fix the build errors
                fix_prompt = "The build failed. Please fix any TypeScript or build errors and ensure `npm run build` succeeds."
                run_kiro_cli(fix_prompt)
        else:
            raise Exception("Build failed after all retries")
        
        # Create output repo and push
        update_status('publishing')
        output_repo_name = create_output_repo(JOB_ID)
        repo_url = push_to_codecommit(output_repo_name)
        
        # Upload artifacts to S3
        summary = upload_artifacts(repo_url)
        
        # Get preview URL from environment
        preview_base = os.environ.get('PREVIEW_URL', '')
        if preview_base:
            preview_url = f"{preview_base}/jobs/{JOB_ID}/build/index.html"
        
        # Update final status
        update_status('done', summary=summary, repo_url=repo_url, preview_url=preview_url)
        log("Job completed successfully!")
        log(f"Repository: {repo_url}")
        log(f"Preview: {preview_url}")
        
    except Exception as e:
        log(f"ERROR: {str(e)}")
        import traceback
        log(traceback.format_exc())
        update_status('failed', error=str(e))
        raise
    
    finally:
        # Always upload logs
        upload_logs()


if __name__ == '__main__':
    main()
