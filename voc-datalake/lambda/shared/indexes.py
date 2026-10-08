"""
DynamoDB GSI names — Python single source of truth (issue #213).

The indexes themselves are defined in lib/stacks/core-stack.ts; these
constants mirror them so handlers never hardcode index-name literals. A
guard test (lambda/shared/test/test_indexes.py) parses the CDK stack and
asserts SET EQUALITY with every ``*_INDEX`` constant below, so a rename or addition on
either side fails CI instead of the live API — the failure mode behind
issue #140, where a handler queried a never-existing 'feedback-id-index'.

The streaming Lambda has its own TypeScript mirror
(lambda/stream/src/indexes.ts) with the same guard.
"""

# voc-feedback table
FEEDBACK_BY_DATE_INDEX = 'gsi1-by-date'
FEEDBACK_BY_CATEGORY_INDEX = 'gsi2-by-category'
FEEDBACK_BY_URGENCY_INDEX = 'gsi3-by-urgency'
FEEDBACK_BY_ID_INDEX = 'gsi4-by-feedback-id'

# voc-aggregates table
AGGREGATES_BY_METRIC_TYPE_INDEX = 'gsi1-by-metric-type'

# voc-projects table
PROJECTS_BY_TYPE_INDEX = 'gsi1-by-type'

# voc-memory table (gsi1pk MEMSTATUS#{scope}#{status}, gsi1sk last touched)
MEMORY_BY_STATUS_INDEX = 'gsi1-by-memory-status'

# voc-agents table (gsi1pk AGENTS | WORKFLOWS | RUNS_ACTIVE)
AGENTS_LISTING_INDEX = 'gsi1-by-agents-listing'
