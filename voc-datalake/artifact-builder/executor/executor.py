#!/usr/bin/env python3
"""
Artifact Builder Executor

Runs inside ECS Fargate to:
1. Pull job request from S3
2. Generate code using Bedrock Claude
3. Build the project
4. Upload artifacts to S3
5. Update job status in DynamoDB
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import boto3

# AWS Clients
s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
bedrock = boto3.client('bedrock-runtime')

# Configuration from environment
JOB_ID = os.environ.get('JOB_ID', '')
ARTIFACTS_BUCKET = os.environ.get('ARTIFACTS_BUCKET', '')
JOBS_TABLE = os.environ.get('JOBS_TABLE', 'artifact-builder-jobs')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

# Bedrock model
BEDROCK_MODEL_ID = 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'

# Paths
WORKSPACE = Path('/workspace')
TEMPLATES_DIR = Path('/app/templates')
SYSTEM_PROMPT_FILE = Path('/app/system_prompt.txt')

jobs_table = dynamodb.Table(JOBS_TABLE)
logs = []


def log(message: str):
    """Log message and store for upload."""
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] {message}"
    print(line)
    logs.append(line)


def update_status(status: str, error: str = None, summary: dict = None):
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


def copy_template(project_type: str):
    """Copy starter template to workspace."""
    template_path = TEMPLATES_DIR / project_type
    if template_path.exists():
        shutil.copytree(template_path, WORKSPACE, dirs_exist_ok=True)
        log(f"Copied template: {project_type}")
    else:
        # Create minimal React + Vite project
        log(f"Template {project_type} not found, creating minimal project")
        create_minimal_react_project()


def create_minimal_react_project():
    """Create a minimal React + Vite + Tailwind project."""
    # package.json
    package_json = {
        "name": "artifact",
        "private": True,
        "version": "0.0.1",
        "type": "module",
        "scripts": {
            "dev": "vite",
            "build": "vite build",
            "preview": "vite preview"
        },
        "dependencies": {
            "react": "^18.2.0",
            "react-dom": "^18.2.0"
        },
        "devDependencies": {
            "@types/react": "^18.2.0",
            "@types/react-dom": "^18.2.0",
            "@vitejs/plugin-react": "^4.2.0",
            "autoprefixer": "^10.4.16",
            "postcss": "^8.4.32",
            "tailwindcss": "^3.4.0",
            "vite": "^5.0.0"
        }
    }
    (WORKSPACE / 'package.json').write_text(json.dumps(package_json, indent=2))
    
    # vite.config.js
    vite_config = '''import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist'
  }
})
'''
    (WORKSPACE / 'vite.config.js').write_text(vite_config)
    
    # tailwind.config.js
    tailwind_config = '''/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
'''
    (WORKSPACE / 'tailwind.config.js').write_text(tailwind_config)
    
    # postcss.config.js
    postcss_config = '''export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
'''
    (WORKSPACE / 'postcss.config.js').write_text(postcss_config)
    
    # index.html
    index_html = '''<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Artifact</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
'''
    (WORKSPACE / 'index.html').write_text(index_html)
    
    # src directory
    src_dir = WORKSPACE / 'src'
    src_dir.mkdir(exist_ok=True)
    
    # src/main.jsx
    main_jsx = '''import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
'''
    (src_dir / 'main.jsx').write_text(main_jsx)
    
    # src/index.css
    index_css = '''@tailwind base;
@tailwind components;
@tailwind utilities;
'''
    (src_dir / 'index.css').write_text(index_css)
    
    # src/App.jsx (placeholder)
    app_jsx = '''export default function App() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <h1 className="text-4xl font-bold text-gray-800">Hello World</h1>
    </div>
  )
}
'''
    (src_dir / 'App.jsx').write_text(app_jsx)
    
    log("Created minimal React + Vite + Tailwind project")


def build_user_prompt(request: dict) -> str:
    """Build the user prompt for Bedrock."""
    prompt = request.get('prompt', '')
    project_type = request.get('project_type', 'react-vite')
    style = request.get('style', 'minimal')
    pages = request.get('pages', [])
    features = request.get('features', [])
    include_mock_data = request.get('include_mock_data', False)
    
    user_prompt = f"""User request: {prompt}

Project type: {project_type}
Style preferences: {style}
"""
    
    if pages:
        user_prompt += f"Pages/routes to create: {', '.join(pages)}\n"
    
    if features:
        user_prompt += f"Features to include: {', '.join(features)}\n"
    
    if include_mock_data:
        user_prompt += "Include realistic mock data for demonstration.\n"
    
    return user_prompt


def invoke_bedrock(system_prompt: str, user_prompt: str) -> str:
    """Invoke Bedrock Claude to generate code."""
    log("Invoking Bedrock Claude Sonnet 4.5...")
    
    request_body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 16000,
        "temperature": 0.3,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_prompt}
        ]
    }
    
    response = bedrock.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps(request_body),
        contentType='application/json',
        accept='application/json'
    )
    
    response_body = json.loads(response['body'].read())
    return response_body['content'][0]['text']


def parse_and_apply_changes(response: str):
    """Parse Bedrock response and apply file changes."""
    log("Parsing AI response and applying changes...")
    
    # Look for file blocks in the response
    # Format: ```filename.ext or ```jsx filename.ext
    import re
    
    # Pattern to match code blocks with filenames
    # Supports: ```jsx src/App.jsx or ```src/App.jsx or FILE: src/App.jsx
    file_pattern = r'(?:FILE:\s*|```(?:\w+\s+)?)([\w./\-]+\.\w+)\s*\n```[\w]*\n(.*?)```'
    
    # Also try simpler pattern
    simple_pattern = r'```(\w+)?\s*\n(.*?)```'
    
    files_written = []
    
    # First try to find explicit file markers
    lines = response.split('\n')
    current_file = None
    current_content = []
    in_code_block = False
    
    for line in lines:
        # Check for file marker
        file_match = re.match(r'^(?:FILE:|###?\s*`?)([/\w.\-]+\.\w+)`?\s*$', line.strip())
        if file_match:
            # Save previous file if any
            if current_file and current_content:
                write_file(current_file, '\n'.join(current_content))
                files_written.append(current_file)
            current_file = file_match.group(1)
            current_content = []
            in_code_block = False
            continue
        
        # Check for code block start
        if line.strip().startswith('```'):
            if in_code_block:
                # End of code block
                in_code_block = False
                if current_file and current_content:
                    write_file(current_file, '\n'.join(current_content))
                    files_written.append(current_file)
                    current_file = None
                    current_content = []
            else:
                # Start of code block - check if filename is on this line
                block_match = re.match(r'^```\w*\s+([/\w.\-]+\.\w+)\s*$', line.strip())
                if block_match:
                    current_file = block_match.group(1)
                in_code_block = True
            continue
        
        # Accumulate content
        if in_code_block and current_file:
            current_content.append(line)
    
    # Handle any remaining content
    if current_file and current_content:
        write_file(current_file, '\n'.join(current_content))
        files_written.append(current_file)
    
    log(f"Applied changes to {len(files_written)} files: {files_written}")
    return files_written


def write_file(filepath: str, content: str):
    """Write content to a file, creating directories as needed."""
    # Clean up filepath
    filepath = filepath.lstrip('/')
    if filepath.startswith('workspace/'):
        filepath = filepath[10:]
    
    full_path = WORKSPACE / filepath
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_text(content)
    log(f"  Wrote: {filepath}")


def run_command(cmd: list, cwd: Path = None) -> tuple[int, str, str]:
    """Run a shell command and return exit code, stdout, stderr."""
    log(f"Running: {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        cwd=cwd or WORKSPACE,
        capture_output=True,
        text=True,
        timeout=300  # 5 minute timeout
    )
    if result.stdout:
        log(f"stdout: {result.stdout[:1000]}")
    if result.stderr:
        log(f"stderr: {result.stderr[:1000]}")
    return result.returncode, result.stdout, result.stderr


def build_project() -> bool:
    """Run npm install and npm run build."""
    update_status('building')
    
    # npm install
    log("Running npm install...")
    code, stdout, stderr = run_command(['npm', 'install'])
    if code != 0:
        log(f"npm install failed with code {code}")
        return False
    
    # npm run build
    log("Running npm run build...")
    code, stdout, stderr = run_command(['npm', 'run', 'build'])
    if code != 0:
        log(f"npm run build failed with code {code}")
        return False
    
    log("Build successful!")
    return True


def create_source_zip() -> Path:
    """Create a zip of the source code."""
    zip_path = WORKSPACE / 'source.zip'
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_path in WORKSPACE.rglob('*'):
            if file_path.is_file():
                # Skip node_modules and dist
                rel_path = file_path.relative_to(WORKSPACE)
                if 'node_modules' in str(rel_path) or str(rel_path).startswith('dist/'):
                    continue
                if str(rel_path) == 'source.zip':
                    continue
                zf.write(file_path, rel_path)
    
    log(f"Created source.zip")
    return zip_path


def upload_artifacts(files_changed: list):
    """Upload all artifacts to S3."""
    update_status('publishing')
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
    dist_dir = WORKSPACE / 'dist'
    if dist_dir.exists():
        for file_path in dist_dir.rglob('*'):
            if file_path.is_file():
                rel_path = file_path.relative_to(dist_dir)
                s3_key = f'jobs/{JOB_ID}/build/{rel_path}'
                
                # Set content type
                content_type = 'application/octet-stream'
                if str(file_path).endswith('.html'):
                    content_type = 'text/html'
                elif str(file_path).endswith('.css'):
                    content_type = 'text/css'
                elif str(file_path).endswith('.js'):
                    content_type = 'application/javascript'
                elif str(file_path).endswith('.json'):
                    content_type = 'application/json'
                elif str(file_path).endswith('.svg'):
                    content_type = 'image/svg+xml'
                elif str(file_path).endswith('.png'):
                    content_type = 'image/png'
                
                s3.upload_file(
                    str(file_path),
                    ARTIFACTS_BUCKET,
                    s3_key,
                    ExtraArgs={'ContentType': content_type}
                )
        log("Uploaded build output")
    
    # Create and upload summary
    summary = {
        'job_id': JOB_ID,
        'files_changed': files_changed,
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
    
    try:
        # Get job request
        request = get_job_request()
        log(f"Got request: {request.get('prompt', '')[:100]}...")
        
        # Copy template
        copy_template(request.get('project_type', 'react-vite'))
        
        # Load system prompt
        system_prompt = SYSTEM_PROMPT_FILE.read_text() if SYSTEM_PROMPT_FILE.exists() else ""
        
        # Build user prompt
        user_prompt = build_user_prompt(request)
        
        # Generate code with Bedrock
        update_status('generating')
        response = invoke_bedrock(system_prompt, user_prompt)
        log(f"Got response from Bedrock ({len(response)} chars)")
        
        # Parse and apply changes
        files_changed = parse_and_apply_changes(response)
        
        # Build the project
        max_retries = 3
        for attempt in range(max_retries):
            if build_project():
                break
            log(f"Build failed, attempt {attempt + 1}/{max_retries}")
            if attempt < max_retries - 1:
                # Ask Bedrock to fix the build
                fix_prompt = f"""The build failed. Here are the errors:

{logs[-5:]}

Please fix the code to make the build pass. Only output the files that need to be changed."""
                response = invoke_bedrock(system_prompt, fix_prompt)
                parse_and_apply_changes(response)
        else:
            raise Exception("Build failed after all retries")
        
        # Upload artifacts
        summary = upload_artifacts(files_changed)
        
        # Update final status
        update_status('done', summary=summary)
        log("Job completed successfully!")
        
    except Exception as e:
        log(f"ERROR: {str(e)}")
        update_status('failed', error=str(e))
        raise
    
    finally:
        # Always upload logs
        upload_logs()


if __name__ == '__main__':
    main()
