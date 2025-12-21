# Sync Steering Documentation

Validate and update steering files (structure.md, tech.md, product.md) by comparing them against the actual codebase.

## Purpose

Ensure steering documentation accurately reflects the current state of the codebase. Source code is the single source of truth.

## Instructions

### Step 1: Scan the Codebase

Generate directory trees for key areas:

```bash
# Lambda functions
find citation-analysis-system/lambda -type f -name "*.py" | head -50

# Web components
find citation-analysis-system/web/src -type f \( -name "*.tsx" -o -name "*.ts" \) | head -80

# Infrastructure
ls -la citation-analysis-system/lib/

# Scripts
ls -la citation-analysis-system/scripts/
```

### Step 2: Read Key Files

Read these files to extract accurate technical details:

**Infrastructure (for tech.md and structure.md):**
- `citation-analysis-system/lib/citation-analysis-stack.ts` - All AWS resources, Lambda configs, DynamoDB tables

**Lambda Functions (for structure.md):**
- List all files in `citation-analysis-system/lambda/api/`
- List all files in `citation-analysis-system/lambda/search/`
- Check other lambda subdirectories

**Web Dashboard (for structure.md):**
- `citation-analysis-system/web/src/App.tsx` - Main app structure, tabs
- List all components in `citation-analysis-system/web/src/components/`
- List all hooks in `citation-analysis-system/web/src/hooks/`
- `citation-analysis-system/web/src/types/index.ts` - TypeScript types

**Package Files (for tech.md):**
- `citation-analysis-system/package.json` - CDK dependencies
- `citation-analysis-system/web/package.json` - Frontend dependencies

### Step 3: Compare and Validate

For each steering file, check:

#### structure.md
- [ ] Lambda function list matches actual files in `lambda/api/` and `lambda/search/`
- [ ] Web component structure matches actual files in `web/src/components/`
- [ ] Hooks list matches actual files in `web/src/hooks/`
- [ ] DynamoDB tables match CDK stack definitions
- [ ] S3 buckets match CDK stack definitions
- [ ] File descriptions are accurate

#### tech.md
- [ ] Python version matches Lambda runtime in CDK stack
- [ ] React/Vite versions match package.json
- [ ] AWS services list is complete
- [ ] API endpoints match actual Lambda handlers
- [ ] S3 bucket names/purposes are accurate
- [ ] AI providers list is current

#### product.md
- [ ] Features list matches implemented functionality
- [ ] Dashboard tabs match App.tsx navigation
- [ ] Industry presets count is accurate
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
ls citation-analysis-system/lambda/api/*.py | wc -l

# Count web components directories
ls -d citation-analysis-system/web/src/components/*/ | wc -l

# Count hooks
ls citation-analysis-system/web/src/hooks/*.ts | wc -l

# Check DynamoDB tables in CDK
grep -c "new dynamodb.Table" citation-analysis-system/lib/citation-analysis-stack.ts

# Check S3 buckets in CDK
grep -c "new s3.Bucket" citation-analysis-system/lib/citation-analysis-stack.ts
```

## What to Check in Each File

### Lambda Functions
For each `.py` file in `lambda/api/`:
- Purpose (from docstring or function names)
- API endpoint it handles
- DynamoDB tables it accesses

For `lambda/search/`:
- Main handler functionality
- AI provider integrations
- Brand extraction logic

### Web Components
For each component directory:
- Main component file and purpose
- Sub-components
- Related hooks

### Infrastructure
From CDK stack:
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
