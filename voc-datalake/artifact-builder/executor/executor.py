#!/usr/bin/env python3
"""
Artifact Builder Executor

Runs inside ECS Fargate to:
1. Pull job request from S3
2. Clone read-only template from CodeCommit
3. Run Kiro CLI in headless autonomous mode to generate code
4. Build the project
5. Create new CodeCommit repo with the result
6. Upload artifacts to S3
7. Update job status in DynamoDB

Kiro CLI Authentication:
- Uses OAuth device flow (one-time manual login required)
- Auth state persisted in EFS-mounted volumes:
  - ~/.kiro/
  - ~/.config/kiro/
  - ~/.local/share/kiro-cli/

Timeout Handling:
- Entrypoint runs with 35-minute timeout (MAX_EXECUTION_TIME)
- Kiro CLI has 25-minute timeout for code generation
- SIGTERM handler ensures job is marked as failed on timeout
"""
import json
import os
import shutil
import signal
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
codecommit = boto3.client('codecommit')

# Configuration from environment - all required, no hardcoded fallbacks
JOB_ID = os.environ.get('JOB_ID', '')
ARTIFACTS_BUCKET = os.environ.get('ARTIFACTS_BUCKET', '')
JOBS_TABLE = os.environ.get('JOBS_TABLE')
if not JOBS_TABLE:
    raise ValueError("JOBS_TABLE environment variable is required")
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
TEMPLATE_REPO_NAME = os.environ.get('TEMPLATE_REPO_NAME')
if not TEMPLATE_REPO_NAME:
    raise ValueError("TEMPLATE_REPO_NAME environment variable is required")

# Paths - app files are in /app, workspace is /workspace (not in EFS-mounted home)
WORKSPACE = Path('/workspace')
TEMPLATE_DIR = WORKSPACE / 'template'
PROJECT_DIR = WORKSPACE / 'project'
KIRO_PROMPT_FILE = Path('/app/kiro_prompt.txt')

jobs_table = dynamodb.Table(JOBS_TABLE)
logs = []


def handle_timeout(signum, frame):
    """Handle SIGTERM from timeout command - mark job as failed and exit."""
    log("TIMEOUT: Task exceeded maximum execution time")
    try:
        upload_logs()
        update_status('failed', error_msg='Task timed out after maximum execution time')
    except Exception as e:
        print(f"Error updating status on timeout: {e}", flush=True)
    sys.exit(124)  # Standard timeout exit code


# Register signal handler for graceful timeout handling
signal.signal(signal.SIGTERM, handle_timeout)


def log(message: str):
    """Log message and store for upload."""
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] {message}"
    print(line, flush=True)
    logs.append(line)


def update_status(status: str, error_msg: str = None, summary: dict = None, 
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
    
    if error_msg:
        update_expr += ', #error = :error'
        expr_names['#error'] = 'error'
        expr_values[':error'] = error_msg
    
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


def get_job_request() -> dict:
    """Download job request from S3."""
    response = s3.get_object(
        Bucket=ARTIFACTS_BUCKET,
        Key=f'jobs/{JOB_ID}/request.json'
    )
    return json.loads(response['Body'].read().decode('utf-8'))


def clone_template_repo(parent_repo_name: str = None):
    """Clone the template or parent repository from CodeCommit."""
    repo_to_clone = parent_repo_name or TEMPLATE_REPO_NAME
    is_iteration = parent_repo_name is not None
    
    log(f"Cloning {'parent' if is_iteration else 'template'} repository: {repo_to_clone}")
    
    # Clean up any existing directories
    if TEMPLATE_DIR.exists():
        shutil.rmtree(TEMPLATE_DIR)
    if PROJECT_DIR.exists():
        shutil.rmtree(PROJECT_DIR)
    
    # Use git-remote-codecommit for authentication
    repo_url = f'codecommit::{AWS_REGION}://{repo_to_clone}'
    
    result = subprocess.run(
        ['git', 'clone', repo_url, str(TEMPLATE_DIR)],
        capture_output=True,
        text=True,
        timeout=180
    )
    
    if result.returncode != 0:
        log(f"Git clone stderr: {result.stderr}")
        raise Exception(f"Failed to clone {'parent' if is_iteration else 'template'}: {result.stderr}")
    
    log(f"Repository cloned successfully to {TEMPLATE_DIR}")
    
    # Copy template to project directory (we'll work here)
    shutil.copytree(TEMPLATE_DIR, PROJECT_DIR, dirs_exist_ok=True)
    
    # Remove .git from project dir - we'll create a fresh repo
    git_dir = PROJECT_DIR / '.git'
    if git_dir.exists():
        shutil.rmtree(git_dir)
    
    log(f"Project directory prepared at {PROJECT_DIR}")
    
    return is_iteration


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


def build_kiro_prompt(request: dict, is_iteration: bool = False) -> str:
    """Build the prompt to send to Kiro CLI."""
    base_prompt = KIRO_PROMPT_FILE.read_text() if KIRO_PROMPT_FILE.exists() else ""
    
    prompt = request.get('prompt', '')
    project_type = request.get('project_type', 'react-vite')
    style = request.get('style', 'minimal')
    pages = request.get('pages', [])
    features = request.get('features', [])
    include_mock_data = request.get('include_mock_data', False)
    parent_job_id = request.get('parent_job_id')
    
    if is_iteration:
        # Iteration prompt - modify existing code
        user_prompt = f"""{base_prompt}

## Iteration Request

You are continuing work on an existing project. The codebase has already been generated in a previous session.

**Previous Job ID:** {parent_job_id}

**New Request:**
{prompt}

## Instructions for Iteration

1. Review the existing codebase structure
2. Make the requested changes while preserving existing functionality
3. Do NOT recreate files that don't need changes
4. Ensure the project still builds successfully with `npm run build`
5. Keep the design consistent with the existing style
6. When done, output a summary of what you changed
"""
    else:
        # New project prompt
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

1. Analyze the existing template structure in the current directory
2. Create or modify files to implement the user's request
3. Ensure the project builds successfully with `npm run build`
4. Keep the design clean and responsive
5. Use the existing shadcn/ui components where appropriate
6. When done, output a summary of what you created
"""
    
    return user_prompt


def run_kiro_cli(prompt: str) -> bool:
    """
    Run Kiro CLI in headless autonomous mode.
    
    Uses:
    - --no-interactive: Headless mode, no TTY required
    - --trust-all-tools: Allow all tool executions without prompts
    
    Auth must be pre-configured via device flow login with persisted state.
    
    Uses Python's pty module to create a proper pseudo-terminal.
    """
    import pty
    import select
    import signal
    
    log("Starting Kiro CLI in headless autonomous mode...")
    
    # Write prompt to a temp file to avoid shell escaping issues
    prompt_file = PROJECT_DIR / '.kiro_prompt.txt'
    prompt_file.write_text(prompt)
    
    # Use Claude Sonnet 4.5 for best results
    model = "claude-sonnet-4.5"
    log(f"Running: kiro-cli chat --model {model} --no-interactive --trust-all-tools '<prompt>'")
    log(f"Working directory: {PROJECT_DIR}")
    
    output_lines = []
    
    def read_output(fd, timeout=1500):
        """Read output from file descriptor with timeout."""
        start_time = datetime.now(timezone.utc)
        while True:
            elapsed = (datetime.now(timezone.utc) - start_time).total_seconds()
            if elapsed > timeout:
                return False, "Timeout"
            
            ready, _, _ = select.select([fd], [], [], 1.0)
            if ready:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    text = data.decode('utf-8', errors='replace')
                    output_lines.append(text)
                    print(text, end='', flush=True)
                except OSError:
                    break
            else:
                # Check if child process is still running
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                    if pid != 0:
                        return True, status
                except ChildProcessError:
                    break
        return True, 0
    
    try:
        # Build the command with Claude Sonnet model
        cmd = f'cd {PROJECT_DIR} && kiro-cli chat --model {model} --no-interactive --trust-all-tools "$(cat {prompt_file})"'
        
        # Use pty.spawn which properly sets up the terminal
        # This creates a proper PTY that Kiro CLI needs
        master_fd, slave_fd = pty.openpty()
        
        pid = os.fork()
        if pid == 0:
            # Child process
            os.close(master_fd)
            os.setsid()
            
            # Set up the slave as the controlling terminal
            import fcntl
            import termios
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            
            if slave_fd > 2:
                os.close(slave_fd)
            
            os.environ['TERM'] = 'xterm-256color'
            os.environ['HOME'] = '/home/kiro'
            os.chdir(str(PROJECT_DIR))
            
            os.execvp('/bin/bash', ['/bin/bash', '-c', cmd])
        
        # Parent process
        os.close(slave_fd)
        
        # Read output
        success, status = read_output(master_fd, timeout=1500)
        
        os.close(master_fd)
        
        # Wait for child to finish
        try:
            _, exit_status = os.waitpid(pid, 0)
            exit_code = os.WEXITSTATUS(exit_status) if os.WIFEXITED(exit_status) else -1
        except ChildProcessError:
            exit_code = 0
        
        full_output = ''.join(output_lines)
        if len(full_output) > 15000:
            full_output = full_output[:7500] + "\n...[truncated]...\n" + full_output[-7500:]
        log(f"Kiro output:\n{full_output}")
        
        if exit_code != 0:
            log(f"Kiro CLI exited with code {exit_code}")
            if not any(PROJECT_DIR.glob('src/**/*.tsx')):
                raise Exception(f"Kiro CLI failed with exit code {exit_code}")
            log("Files were created despite non-zero exit, continuing...")
        
        return True
        
    except Exception as e:
        log(f"Error running Kiro CLI: {e}")
        import traceback
        log(traceback.format_exc())
        raise


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
    """Run npm install with all dependencies (including devDependencies)."""
    log("Installing dependencies...")
    # Use --include=dev to ensure devDependencies are installed (needed for build tools)
    code, _, _ = run_command(['npm', 'install', '--include=dev'], timeout=300)
    return code == 0


def build_project() -> bool:
    """Run npm run build."""
    log("Building project...")
    code, _, _ = run_command(['npm', 'run', 'build'], timeout=300)
    return code == 0


def push_to_codecommit(repo_name: str, prompt_summary: str = None) -> str:
    """Initialize git repo and push to CodeCommit."""
    log(f"Pushing to CodeCommit repository: {repo_name}")
    
    # Initialize git repo
    run_command(['git', 'init'], cwd=PROJECT_DIR)
    run_command(['git', 'add', '-A'], cwd=PROJECT_DIR)
    
    # Create commit message with summary
    commit_msg = f'Generated artifact for job {JOB_ID}'
    if prompt_summary:
        # Truncate summary if too long
        summary = prompt_summary[:200] + '...' if len(prompt_summary) > 200 else prompt_summary
        commit_msg = f'{commit_msg}\n\n{summary}'
    
    run_command(['git', 'commit', '-m', commit_msg], cwd=PROJECT_DIR)
    
    # Add remote and push
    repo_url = f'codecommit::{AWS_REGION}://{repo_name}'
    run_command(['git', 'remote', 'add', 'origin', repo_url], cwd=PROJECT_DIR)
    
    code, _, stderr = run_command(['git', 'push', '-u', 'origin', 'main', '--force'], cwd=PROJECT_DIR)
    
    if code != 0:
        # Try with master branch
        run_command(['git', 'branch', '-M', 'master'], cwd=PROJECT_DIR)
        code, _, _ = run_command(['git', 'push', '-u', 'origin', 'master', '--force'], cwd=PROJECT_DIR)
    
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
    log(f"Artifacts bucket: {ARTIFACTS_BUCKET}")
    
    repo_url = None
    preview_url = None
    
    try:
        # Get job request
        request = get_job_request()
        parent_repo_name = request.get('parent_repo_name')
        parent_job_id = request.get('parent_job_id')
        
        if parent_job_id:
            log(f"ITERATION MODE: Continuing from job {parent_job_id}")
        
        log(f"Got request: {request.get('prompt', '')[:200]}...")
        
        # Clone template or parent repo from CodeCommit
        update_status('cloning')
        is_iteration = clone_template_repo(parent_repo_name)
        
        # Build Kiro prompt
        kiro_prompt = build_kiro_prompt(request, is_iteration)
        log(f"Built prompt ({len(kiro_prompt)} chars)")
        
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
                fix_prompt = """The build failed. Please:
1. Read the error messages above
2. Fix any TypeScript, ESLint, or build errors
3. Ensure `npm run build` succeeds
4. Do not remove functionality, just fix the errors"""
                run_kiro_cli(fix_prompt)
        else:
            raise Exception("Build failed after all retries")
        
        # Create output repo and push
        update_status('publishing')
        output_repo_name = create_output_repo(JOB_ID)
        prompt_summary = request.get('prompt', '')
        repo_url = push_to_codecommit(output_repo_name, prompt_summary)
        
        # Upload artifacts to S3
        summary = upload_artifacts(repo_url)
        
        # Add iteration info to summary
        if parent_job_id:
            summary['parent_job_id'] = parent_job_id
            summary['is_iteration'] = True
        
        # Get preview URL from environment
        preview_base = os.environ.get('PREVIEW_URL', '')
        if preview_base:
            preview_url = f"{preview_base}/jobs/{JOB_ID}/build/index.html"
        
        # Update final status
        update_status('done', summary=summary, repo_url=repo_url, preview_url=preview_url)
        log("=" * 50)
        log("Job completed successfully!")
        if parent_job_id:
            log(f"Iterated from: {parent_job_id}")
        log(f"Repository: {repo_url}")
        log(f"Preview: {preview_url}")
        log("=" * 50)
        
    except Exception as e:
        log(f"ERROR: {str(e)}")
        import traceback
        log(traceback.format_exc())
        update_status('failed', error_msg=str(e))
        raise
    
    finally:
        # Always upload logs
        upload_logs()


if __name__ == '__main__':
    main()
