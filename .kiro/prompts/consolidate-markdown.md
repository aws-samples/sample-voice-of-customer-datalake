# Consolidate Markdown Documentation

Find all `.md` files in the workspace and consolidate them according to the documentation policy.

## CRITICAL RULES

1. **DO NOT CREATE NEW FILES** - Only update existing core documentation files
2. **DO NOT CREATE SUMMARY FILES** - Report results verbally only
3. **DO NOT CREATE BACKUP FILES** - Delete originals after consolidation
4. **VALIDATE BEFORE REPORTING** - Verify all technical details against source code

## Instructions

1. **Find all markdown files** in the project (excluding node_modules, build artifacts, and third-party dependencies)

2. **Categorize each file** by content type:
   - Technical/Architecture details → `.kiro/SYSTEM_DOCUMENTATION.md`
   - Technology stack info → `.kiro/steering/tech.md`
   - Project structure/organization → `.kiro/steering/structure.md`
   - Product features/overview → `.kiro/steering/product.md`
   - Quick start/setup → `{project}/README.md`
   - Project navigation → `PROJECT_SUMMARY.md`

3. **Read and compare content**:
   - Read each scattered markdown file
   - Read the destination file to understand existing content
   - Compare information - identify what's new, what's duplicate, what conflicts
   - Determine if scattered file has newer/better information than destination

4. **Consolidate intelligently**:
   - If scattered file has NEW information → Add to destination
   - If scattered file has UPDATED information → Update destination
   - If scattered file has DUPLICATE information → Skip (don't duplicate)
   - If scattered file has CONFLICTING information → Validate against source code, use correct version
   - Maintain consistent formatting and structure
   - Update table of contents if needed

5. **Delete consolidated files**:
   - Remove the original scattered markdown files
   - Remove any .backup, .tmp, .old files
   - Keep only the core documentation files

6. **Validate documentation accuracy** (CRITICAL):
   - Cross-reference ALL technical details against actual source code
   - Verify configuration values (timeouts, concurrency, retries) in CDK stack
   - Check API client implementations match documentation
   - Verify Lambda function configurations
   - Ensure all numbers, settings, and technical details are accurate
   - Update documentation if it doesn't match source code (source code is truth)

7. **Preserve exceptions**:
   - Component-specific READMEs (standalone modules with unique setup)
   - Spec files in `.kiro/specs/`
   - Steering files in `.kiro/steering/`
   - Prompt files in `.kiro/prompts/`
   - Third-party library documentation (in node_modules, dependencies, etc.)
   - Build artifacts (in cdk.out, dist, build, etc.)

## Core Documentation Files (Keep)

- `.kiro/SYSTEM_DOCUMENTATION.md` - Complete technical documentation
- `.kiro/steering/tech.md` - Technology stack
- `.kiro/steering/structure.md` - Project structure
- `.kiro/steering/product.md` - Product overview
- `.kiro/steering/documentation-policy.md` - This policy
- `{project}/README.md` - Main project README
- `PROJECT_SUMMARY.md` - Quick navigation guide

## Files to Delete

- Scattered documentation in project root (DEPLOYMENT.md, FIXES.md, etc.)
- Duplicate documentation in subdirectories
- Temporary documentation files
- Per-feature markdown files (unless standalone component)
- Deployment status files (DEPLOYMENT_COMPLETE.md, etc.)

## Validation Checklist (MANDATORY)

After consolidation, verify against source code:

### Configuration Values
- [ ] Lambda timeout values match `citation-analysis-stack.ts`
  - Use: `grep -n "timeout: cdk.Duration" citation-analysis-stack.ts`
- [ ] Concurrency limits (maxConcurrency) match `citation-analysis-stack.ts`
  - Use: `grep -n "maxConcurrency" citation-analysis-stack.ts`
- [ ] Step Functions retry configuration matches `citation-analysis-stack.ts`
  - Use: `grep -A 3 "addRetry" citation-analysis-stack.ts`
- [ ] Memory sizes match Lambda function definitions
  - Use: `grep -n "memorySize" citation-analysis-stack.ts`

### API Client Implementation
- [ ] Retry logic (max attempts) matches `lambda/search/api_clients.py`
  - Use: `grep -n "max_retries" lambda/search/api_clients.py`
- [ ] Backoff formula matches implementation
  - Check the actual calculation in the code
- [ ] Retry conditions (HTTP codes) match implementation
  - Check which status codes trigger retries
- [ ] API timeout values match implementation
  - Check timeout parameters in API calls

### Content Comparison
- [ ] Compare scattered file content with destination file content
- [ ] Identify what's new vs duplicate vs conflicting
- [ ] Only add genuinely new information
- [ ] Update outdated information with newer version
- [ ] Don't duplicate existing content

### Cross-Reference
- [ ] README.md quick start matches detailed docs
- [ ] SYSTEM_DOCUMENTATION.md technical details are accurate
- [ ] tech.md technology stack is current
- [ ] All links and references are valid

### Report Discrepancies
If documentation doesn't match source code:
1. Update documentation to match source code (source code is truth)
2. Log the correction in your response
3. Explain what was incorrect and what it was changed to

## Expected Outcome

After consolidation:
- All documentation in predictable locations
- No scattered markdown files in project directories
- No new files created (no summaries, no backups, no temp files)
- Single source of truth for each type of documentation
- Documentation validated against source code
- All technical details accurate and up-to-date
- No duplicate information
- Cleaner repository structure
- Easier navigation for developers

## Final Report Format (VERBAL ONLY - DO NOT CREATE A FILE)

Provide in your response:

1. **Files Consolidated**: 
   - List what was merged where
   - Note if content was new, updated, or duplicate

2. **Files Deleted**: 
   - List of removed scattered files
   - List of removed backup/temp files

3. **Content Decisions**:
   - What new information was added
   - What information was updated
   - What duplicate information was skipped

4. **Validation Results**: 
   - All checks passed/failed
   - Specific values verified (timeouts, retries, concurrency)

5. **Corrections Made**: 
   - Documentation that was updated to match source code
   - What was wrong and what it was changed to

6. **Confirmation**: 
   - Documentation is accurate and consolidated
   - No new files were created
   - Ready for use
