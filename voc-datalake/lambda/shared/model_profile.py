"""
Model profile of the current invocation (owner decision, 5.61.00).

The production e2e suite signs in as users in the Cognito group ``e2e``. Every
model call the APP makes for them resolves to one cheap model (Haiku 5.5, see
``shared.model_config.PROFILE_MODELS``) on every surface, so a full e2e run does
not spend flagship-model money. Real users keep the models the admin picked; the
admin picker itself is never changed. The image model (persona avatars) is not
part of a profile.

Trust: a profile is derived ONLY from verified data —

- the ``cognito:groups`` claim of the API Gateway Cognito authorizer, or of a
  synthetic event built by a trusted invoker that verified the caller (the stream
  Lambda forwards the caller's verified claims; plan steps re-read the approver's
  groups in Cognito);
- a ``model_profile`` field on a job payload / stored record that such a verified
  request wrote (assist jobs, Step Functions inputs, agent runs, plans, processing
  queue messages from an authenticated importer).

Never from a request body, a query string, a header or a model's output.

State: one module-level value for the invocation, set by ``model_profile_scope``
and restored when the scope ends. A Lambda execution environment runs one
invocation at a time, and worker threads (``shared.concurrency``, the persona
panel) see the value — a ``ContextVar`` would not reach a ``ThreadPoolExecutor``
worker. Code that handles several callers in one invocation (an SQS batch) opens
one scope per record.
"""
import functools
from collections.abc import Callable, Generator, Iterable, Mapping
from contextlib import contextmanager
from typing import Any, Final

E2E_PROFILE: Final = 'e2e'
# The Cognito group (VocCoreStack, lib/stacks/core-auth.ts) whose members get E2E_PROFILE.
E2E_GROUP: Final = 'e2e'
PROFILES: Final = frozenset({E2E_PROFILE})

# The field a job payload / stored record carries the profile in.
PAYLOAD_KEY: Final = 'model_profile'

_state: dict[str, str | None] = {'profile': None}


def parse_profile(value: object) -> str | None:
    """``value`` when it names a known profile, else None (unknown values are ignored, never raised)."""
    return value if isinstance(value, str) and value in PROFILES else None


def profile_for_groups(groups: Iterable[str]) -> str | None:
    """The profile for a caller in ``groups`` (verified Cognito groups only; a parsed list, not the raw claim)."""
    if isinstance(groups, str):
        groups = [groups]
    return E2E_PROFILE if E2E_GROUP in {g.strip() for g in groups} else None


def profile_from_payload(payload: object) -> str | None:
    """The profile a trusted payload / stored record carries under PAYLOAD_KEY, else None."""
    return parse_profile(payload.get(PAYLOAD_KEY)) if isinstance(payload, Mapping) else None


# The job configs `projects_handler._started_job` stamps (``stamp_config``) and the job
# Lambdas / Step Functions steps receive as a top-level event field.
JOB_CONFIG_KEYS: Final = ('research_config', 'doc_config', 'merge_config', 'import_config', 'filters')


def profile_from_job_event(event: object) -> str | None:
    """The profile an internal invocation event carries, else None.

    Read from the event's top level (an async invoke / queue message built by a
    trusted Lambda; API Gateway never lets a client set a top-level event field)
    or from one of the stamped job configs in JOB_CONFIG_KEYS. Never from any
    other nested value: those may hold request-body content.
    """
    if not isinstance(event, Mapping):
        return None
    direct = profile_from_payload(event)
    if direct:
        return direct
    for key in JOB_CONFIG_KEYS:
        nested = profile_from_payload(event.get(key))
        if nested:
            return nested
    return None


def stamp_config(config: dict) -> dict:
    """Set ``config``'s PAYLOAD_KEY to the active profile IN PLACE (removed when none), and return it.

    Job configs are built from request bodies (some spread the whole body), so a
    client-sent ``model_profile`` is dropped here and only the server's value is kept.
    """
    config.pop(PAYLOAD_KEY, None)
    config.update(payload_fields())
    return config


def active_profile() -> str | None:
    """The profile in force for this invocation, or None (the configured models apply)."""
    return _state['profile']


def payload_fields() -> dict[str, str]:
    """``{PAYLOAD_KEY: <profile>}`` while a profile is active, else ``{}``: merge into a job payload."""
    profile = active_profile()
    return {PAYLOAD_KEY: profile} if profile else {}


@contextmanager
def model_profile_scope(profile: object) -> Generator[str | None]:
    """Run the block with ``profile`` in force (None or an unknown value = no profile).

    Restores the previous value on exit, so a warm container never carries one
    caller's profile into the next invocation, and nested scopes (an assist job
    inside an API handler) behave.
    """
    previous = _state['profile']
    _state['profile'] = parse_profile(profile)
    try:
        yield _state['profile']
    finally:
        _state['profile'] = previous


def with_model_profile[R](
    resolve: Callable[[Any], str | None],
) -> Callable[[Callable[[Any, Any], R]], Callable[[Any, Any], R]]:
    """Decorate an ``(event, context)`` Lambda handler: run it in the scope of ``resolve(event)``.

    ``shared.api.api_handler`` resolves from the verified groups claim (and an
    internal event's stamped field); ``shared.invocation_cost.instrumented_handler``
    from the job event only.
    """
    def decorate(func: Callable[[Any, Any], R]) -> Callable[[Any, Any], R]:
        @functools.wraps(func)
        def wrapper(event: Any, context: Any) -> R:
            with model_profile_scope(resolve(event)):
                return func(event, context)
        return wrapper
    return decorate
