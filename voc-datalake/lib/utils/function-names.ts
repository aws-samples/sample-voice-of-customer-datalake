/**
 * Base physical names of the Lambdas one stack addresses in ANOTHER stack by
 * deterministic name rather than by construct reference.
 *
 * VocProcessingStack deploys before VocApiStack, yet its agent conductor and
 * persona panel call the Projects and Memory APIs (synthetic API Gateway
 * events acting as the agent principal). A construct reference would make
 * Processing depend on Api — a cycle — so both stacks build the same name from
 * these constants through their own prefix-aware `uniqueName()` instead. Same
 * pattern as CATEGORY_REPROCESS_FUNCTION_BASE_NAME in the other direction.
 */
export const PROJECTS_API_FUNCTION_BASE_NAME = 'voc-projects-api';
export const MEMORY_API_FUNCTION_BASE_NAME = 'voc-memory-api';
/** aggregate_reviews reads in-scope feedback through GET /feedback (metrics_handler). */
export const METRICS_API_FUNCTION_BASE_NAME = 'voc-metrics-api';
/**
 * The retention / erasure worker (VocProcessingStack). The settings API in
 * VocApiStack starts erasure jobs by async invoke of this name (RETENTION_FUNCTION).
 */
export const RETENTION_FUNCTION_BASE_NAME = 'voc-retention';
/**
 * The Radar release scan (VocProcessingStack, docs/radar.md). The Radar API in VocApiStack
 * starts "Scan now" by async invoke of this name (RADAR_SCAN_FUNCTION).
 */
export const RADAR_SCAN_FUNCTION_BASE_NAME = 'voc-radar-scan';
/**
 * The live-website design capture (VocIngestionStack, docs/company-context.md). The settings API in
 * VocApiStack starts it for a `website` design reference by async invoke of this name
 * (DESIGN_CAPTURE_FUNCTION).
 */
export const DESIGN_CAPTURE_FUNCTION_BASE_NAME = 'voc-design-capture';
/** The Radar API (VocApiStack): /radar, /radar/{proxy+}; the assistant's `get_radar` reads it. */
export const RADAR_API_FUNCTION_BASE_NAME = 'voc-radar-api';
/**
 * Plan mode (docs/assistant-plan-mode.md). `voc-plan-step` (VocProcessingStack) runs one step of an
 * approved assistant plan AS ITS APPROVER: it reads through the same domain APIs as the streaming
 * assistant and executes a plan's writes through the same REST routes the SPA's approval cards call.
 * It reaches each of these VocApiStack Lambdas by deterministic name (Processing deploys first).
 */
export const PLAN_STEP_FUNCTION_BASE_NAME = 'voc-plan-step';
export const FEEDBACK_FORM_API_FUNCTION_BASE_NAME = 'voc-feedback-form-api';
export const SETTINGS_API_FUNCTION_BASE_NAME = 'voc-settings-api';
export const SCRAPERS_API_FUNCTION_BASE_NAME = 'voc-scrapers-api';
export const AGENTS_API_FUNCTION_BASE_NAME = 'voc-agents-api';
export const USERS_API_FUNCTION_BASE_NAME = 'voc-users-api';
/** `create_app_connector` (POST /integrations/{source}/apps) and `run_source` (POST /sources/{source}/run). */
export const INTEGRATIONS_API_FUNCTION_BASE_NAME = 'voc-integrations-api';
/** `set_feedback_category` (PUT /feedback/{id}/category). */
export const FEEDBACK_EDIT_API_FUNCTION_BASE_NAME = 'voc-feedback-edit-api';
/**
 * The global MCP endpoint (VocApiStack, global-mcp.ts). Also its Powertools `service`, the dimension
 * of its `VoC-MCP-Global` metrics, which the runtime MCP alarms filter on (dlq-alarms.ts → ops_alerts.py).
 */
export const GLOBAL_MCP_SERVICE_NAME = 'voc-mcp-global-api';
