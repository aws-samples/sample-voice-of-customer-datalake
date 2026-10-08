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
