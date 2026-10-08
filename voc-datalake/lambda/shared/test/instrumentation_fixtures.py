"""The one pin every handler suite puts on its Powertools instrumentation.

Each `@tracer.capture_method` leaves the route as the tracer's wrapper, with the
real function behind `__wrapped__`; a dropped decorator is a function defined in
the handler's own file with no `__wrapped__` at all. The check is the same for
every handler, so it is written once here and each mutation suite only names
its routes.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from types import ModuleType

TRACER_SOURCE = os.path.join('tracing', 'tracer.py')


def assert_tracer_wrapped(module: ModuleType, name: str) -> None:
    """Fail unless ``module.<name>`` is Powertools' tracer wrapper around a function of that exact
    qualname: the wrapper's code lives in `tracing/tracer.py` and `__wrapped__` is the route."""
    func: Callable = getattr(module, name)
    filename = func.__code__.co_filename
    if not filename.endswith(TRACER_SOURCE):
        raise AssertionError(f'{module.__name__}.{name} is not the tracer wrapper: defined in {filename}')
    wrapped = vars(func).get('__wrapped__')
    if wrapped is None:
        raise AssertionError(f'{module.__name__}.{name} carries no __wrapped__')
    if wrapped.__qualname__ != name:
        raise AssertionError(f'{module.__name__}.{name} wraps {wrapped.__qualname__!r}, not {name!r}')


def assert_handler_wrapped(module: ModuleType) -> None:
    """Fail unless ``module.lambda_handler`` still carries its decorator (`api_handler`): the
    wrapper leaves the real `lambda_handler` behind ``__wrapped__``."""
    wrapped = vars(module.lambda_handler).get('__wrapped__')
    if wrapped is None or wrapped.__qualname__ != 'lambda_handler':
        raise AssertionError(f'{module.__name__}.lambda_handler is not wrapped by its decorator')



# The wrappers `shared.invocation_cost.instrumented_handler` puts on a handler, outermost first, each
# named by the tail of the file that defines it.
_INSTRUMENTED_WRAPPERS = (
    os.path.join('logging', 'logger.py'),
    TRACER_SOURCE,
    os.path.join('metrics', 'provider', 'base.py'),
    os.path.join('shared', 'invocation_cost.py'),
)
INSTRUMENTED_HANDLER_LAYERS = (*_INSTRUMENTED_WRAPPERS, 'lambda_handler')


def handler_layers(function: Callable) -> tuple[str, ...]:
    """A decorated handler's ``__wrapped__`` chain: each wrapper as the known file tail that defines it
    (or its full path when unknown), then the innermost function's qualified name."""
    names: list[str] = []
    current = function
    while '__wrapped__' in vars(current):
        filename = current.__code__.co_filename
        names.append(next((tail for tail in _INSTRUMENTED_WRAPPERS if filename.endswith(tail)), filename))
        current = vars(current)['__wrapped__']
    names.append(current.__qualname__)
    return tuple(names)
