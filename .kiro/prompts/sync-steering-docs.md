# Sync Steering Documentation

Validate and update steering files (structure.md, tech.md, product.md) by comparing them against the actual codebase.

## Purpose

Ensure steering documentation accurately reflects the current state of the codebase. Source code is the single source of truth.

## Instructions

### Step 1: Scan the Codebase

Generate directory trees for key areas:

```bash
# Lambda functions
find voc-datalake/lambda -type f -name "*.py" | head -50

# Frontend components
find voc-datalake/frontend/src -type f \( -name "*.tsx" -o -name "*.ts" \) | head -80

# Infrastructure
ls -la voc-datalake/lib/stacks/

# Scripts
ls -la voc-datalake/scripts/
```

### Step 2: Read Key Files

Read these files to extract accurate technical details:

**Infrastructure (for tech.md and structure.md):**
- `voc-datalake/lib/stacks/*.ts` - All AWS resources, Lambda configs, DynamoDB tables

**Lambda Functions (for structure.md):**
- List all files in `voc-datalake/lambda/api/`
- List all files in `voc-datalake/lambda/ingestors/`
- Check other lambda subdirectories

**Frontend Dashboard (for structure.md):**
- `voc-datalake/frontend/src/App.tsx` - Main app structure
- List all components in `voc-datalake/frontend/src/components/`
- List all pages in `voc-datalake/frontend/src/pages/`
- `voc-datalake/frontend/src/api/client.ts` - API client types

**Package Files (for tech.md):**
- `voc-datalake/package.json` - CDK dependencies
- `voc-datalake/frontend/package.json` - Frontend dependencies

### Step 3: Compare and Validate

For each steering file, check:

#### structure.md
- [ ] Lambda function list matches actual files in `lambda/api/` and `lambda/ingestors/`
- [ ] Frontend component structure matches actual files in `frontend/src/components/`
- [ ] Pages list matches actual files in `frontend/src/pages/`
- [ ] DynamoDB tables match CDK stack definitions
- [ ] S3 buckets match CDK stack definitions
- [ ] File descriptions are accurate

#### tech.md
- [ ] Python version matches Lambda runtime in CDK stack
- [ ] React/Vite versions match package.json
- [ ] AWS services list is complete
- [ ] API endpoints match actual Lambda handlers
- [ ] S3 bucket names/purposes are accurate
- [ ] AI model (Bedrock) configuration is current

#### product.md
- [ ] Features list matches implemented functionality
- [ ] Dashboard pages match frontend routes
- [ ] Data sources count is accurate
- [ ] Component descriptions are current

### Step 4: Update Steering Files

For each discrepancy found:

1. **Missing items**: Add new files/components/features to documentation
2. **Removed items**: Remove deprecated/deleted items from documentation
3. **Renamed items**: Update names to match current codebase
4. **Incorrect details**: Fix technical details (versions, configs, etc.)

### Step 5: Validation Checklist

Run these checks to verify accuracy:

```bash
# Count Lambda API handlers
ls voc-datalake/lambda/api/*.py | wc -l

# Count frontend components
ls voc-datalake/frontend/src/components/*.tsx | wc -l

# Count frontend pages
ls voc-datalake/frontend/src/pages/*.tsx | wc -l

# Count ingestors
ls -d voc-datalake/lambda/ingestors/*/ | wc -l

# Check DynamoDB tables in CDK
grep -c "new dynamodb.Table" voc-datalake/lib/stacks/storage-stack.ts

# Check S3 buckets in CDK
grep -c "new s3.Bucket" voc-datalake/lib/stacks/storage-stack.ts
```

## What to Check in Each File

### Lambda Functions
For each `.py` file in `lambda/api/`:
- Purpose (from docstring or function names)
- API endpoint it handles
- DynamoDB tables it accesses

For `lambda/ingestors/`:
- Data source it ingests from
- Authentication method
- Schedule frequency

### Frontend Components
For each component:
- Main component file and purpose
- Props interface
- Related hooks or stores

### Infrastructure
From CDK stacks:
- Lambda function configurations (memory, timeout, runtime)
- DynamoDB table schemas (partition key, sort key)
- S3 bucket configurations
- API Gateway routes
- Step Functions workflow

## Output Format

After validation, report:

1. **Files Scanned**: List of directories/files examined
2. **Discrepancies Found**: What doesn't match between docs and code
3. **Updates Made**: Changes applied to steering files
4. **Verification**: Confirmation that docs now match codebase

## Rules

- DO NOT create new documentation files
- DO NOT add speculative features (only document what exists)
- DO NOT remove sections without verifying the code is actually gone
- Source code is always the truth - update docs to match code, not vice versa
- Keep formatting consistent with existing steering file style
- Preserve the overall structure of each steering file
