"""An asynchronous invocation of this same Lambda function: an app-review run's next part
(``_shared/app_reviews_parts.py``) and the scheduled tick's per-workspace runs (``_shared/base_ingestor.py``
``fan_out_tick``). The function's role may invoke its own function and no other (lib/stacks/ingestion-roles.ts).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.aws import invoke_lambda_async

__all__ = ["invoke_self"]

ASYNC_INVOKE_ACCEPTED = 202


def invoke_self(event: dict) -> None:
    """Invoke this function (``AWS_LAMBDA_FUNCTION_NAME``) asynchronously with *event*; RuntimeError when the
    name is not set or Lambda does not accept the event (any client error propagates)."""
    function_name = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
    if not function_name:
        raise RuntimeError("AWS_LAMBDA_FUNCTION_NAME is not set")
    status = invoke_lambda_async(function_name, event).get("StatusCode")
    if status != ASYNC_INVOKE_ACCEPTED:
        raise RuntimeError(f"async invoke answered {status}")
