"""Node executors — one module per workflow node type.

Each module exposes ``start(ctx) -> dict`` and, when it starts an async project
job, ``finish(ctx, job) -> dict``. Results are built with ``agents.nodes.base``
and are small (ids and summaries, never document bodies) because they travel
through Step Functions state.
"""
