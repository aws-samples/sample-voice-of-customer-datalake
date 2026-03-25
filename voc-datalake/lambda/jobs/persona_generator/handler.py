"""
Persona Generator Job Lambda Handler

Generates UX research personas from customer feedback using multi-step LLM chain.
"""

import os
import sys

# Add parent directory to path for shared module imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from shared.logging import logger, tracer, metrics
from shared.jobs import job_handler, JobContext
from shared.exceptions import ConfigurationError

# Import from api/projects.py - the business logic stays there
from api.projects import generate_personas


@job_handler(error_message='Persona generation failed')
def handle_job(ctx: JobContext, project_id: str, job_id: str, filters: dict) -> dict:
    """Handle async persona generation job.
    
    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        job_id: Job ID
        filters: Generation filters (sources, categories, sentiments, days, persona_count, custom_instructions)
        
    Returns:
        Result dict with generated personas
    """
    def progress_callback(progress: int, step: str):
        ctx.update_progress(progress, step)
    
    result = generate_personas(project_id, filters, progress_callback=progress_callback)
    return result


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point."""
    logger.info(f"Persona generator invoked with event keys: {list(event.keys())}")
    return handle_job(event)
