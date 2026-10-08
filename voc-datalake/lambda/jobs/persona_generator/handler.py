"""
Persona Generator Job Lambda Handler

Generates UX research personas from customer feedback using multi-step LLM chain.
"""

# Import from api/projects.py - the business logic stays there
from api.projects import generate_personas
from shared.invocation_cost import instrumented_handler
from shared.jobs import JobContext, job_handler
from shared.logging import logger


@job_handler(error_message='Persona generation failed')
def handle_job(ctx: JobContext, project_id: str, _job_id: str, filters: dict) -> dict:
    """Handle async persona generation job.

    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        _job_id: Job ID (unused; part of the job_handler callback signature)
        filters: Generation filters (sources, categories, sentiments, days, persona_count, custom_instructions)

    Returns:
        Result dict with generated personas
    """
    def progress_callback(progress: int, step: str):
        ctx.update_progress(progress, step)

    return generate_personas(project_id, filters, progress_callback=progress_callback)
@instrumented_handler
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Persona generator invoked with event keys: {list(event.keys())}")
    return handle_job(event, context)
