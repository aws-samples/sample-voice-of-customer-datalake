# Manual Import Handler Refactor

## Overview
Refactor `manual_import_handler.py` to improve consistency, error handling, and maintainability while preserving existing functionality.

## User Stories

### Story 1: Consistent Error Handling
**As a** developer  
**I want** all API endpoints to use the same error handling pattern  
**So that** error responses are predictable and debugging is easier

**Acceptance Criteria:**
- [x] `get_parse_status` raises `NotFoundError` when job doesn't exist (instead of returning dict)
- [x] `get_parse_status` raises `ServiceError` on database failures (instead of returning dict)
- [x] All error paths use the exception classes from `shared/exceptions.py`

### Story 2: Configuration Validation
**As a** developer  
**I want** `start_parse` to validate required configuration upfront  
**So that** misconfiguration is caught early with clear error messages

**Acceptance Criteria:**
- [x] `start_parse` raises `ConfigurationError` if `aggregates_table` is None
- [x] `start_parse` raises `ConfigurationError` if `MANUAL_IMPORT_PROCESSOR_FUNCTION` is not set
- [x] Error messages clearly indicate which configuration is missing

### Story 3: Reduce Code Duplication
**As a** developer  
**I want** common patterns extracted into helper functions  
**So that** the code is DRY and easier to maintain

**Acceptance Criteria:**
- [x] Partition key generation (`MANUAL_IMPORT#{job_id}`) extracted to helper function
- [x] Helper function used consistently across all handlers

### Story 4: Optimize Lambda Client Initialization
**As a** developer  
**I want** the Lambda client initialized at module level  
**So that** cold start latency is reduced and client reuse is maximized

**Acceptance Criteria:**
- [x] Lambda client created at module level alongside other AWS clients
- [x] Client initialization uses `get_lambda_client()` pattern if available, or direct boto3 call

### Story 5: Improve Error Logging
**As a** developer  
**I want** caught exceptions to be logged before being swallowed  
**So that** debugging production issues is easier

**Acceptance Criteria:**
- [x] `extract_source_from_url` logs exceptions before returning "unknown"
- [x] Log level is appropriate (warning or debug, not error)

## Out of Scope
- Changes to the async processor (`manual_import_processor.py`)
- Changes to the LLM prompts
- Adding new functionality

## Technical Notes
- All changes must maintain backward compatibility with existing API contracts
- Tests in `test_manual_import_handler.py` must continue to pass
