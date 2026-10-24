"""Builders for tests that stand in for ``converse_chain_detailed``."""
from shared.converse import ConverseResult

# The model a stubbed chain step reports having run on.
CHAIN_MODEL_ID = 'global.anthropic.claude-sonnet-5'


def chain_results(texts: list[str], model_id: str = CHAIN_MODEL_ID) -> list[ConverseResult]:
    """One ``ConverseResult`` per text, each reporting *model_id* — the shape
    ``converse_chain_detailed`` returns."""
    return [ConverseResult(text=text, model_id=model_id) for text in texts]



def metric_recorder(sink: list[dict]) -> type:
    """A stand-in for powertools ``single_metric`` that appends each emission
    to *sink* as ``{**kwargs, 'dimensions': {...}}`` instead of printing EMF.
    Patch a module's ``single_metric`` with the returned class."""

    class RecordingMetric:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.dimensions: dict = {}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            sink.append({**self.kwargs, 'dimensions': self.dimensions})
            return False

        def add_dimension(self, name, value):
            self.dimensions[name] = value

    return RecordingMetric
