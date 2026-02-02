# Consolidate Duplicated Utility Functions Across Lambda Handlers

Closes #11

## Summary

This PR consolidates duplicated utility functions across Lambda handlers into the shared module, improving code maintainability and reducing duplication.

## Changes

### New Shared Modules

- **`shared/tables.py`** - Centralized DynamoDB table accessors:
  - `get_aggregates_table()`
  - `get_jobs_table()`
  - `get_projects_table()`
  - `get_feedback_table()`

- **`shared/jobs.py`** - Centralized job management utilities:
  - `create_job()` - Create a new job record
  - `update_job_status()` - Update job status with optional result/error
  - `get_job()` - Retrieve a job by project_id and job_id

- **`shared/api.py`** - Added `decimal_default()` for JSON serialization of Decimal types

### Updated Handlers

- `projects_handler.py` - Now uses shared tables and jobs modules
- `scrapers_handler.py` - Now uses shared `get_aggregates_table`
- `manual_import_handler.py` - Now uses shared `decimal_default`
- `research_step_handler.py` - Now uses shared jobs module

### Test Fixes

Fixed pre-existing test issues unrelated to this PR:
- `test_users_handler.py` - Fixed invalid group names ('viewers' → 'users') to match handler validation
- `test_aws.py` - Updated test to match bedrock client config changes

## Testing

All 507 tests pass.
