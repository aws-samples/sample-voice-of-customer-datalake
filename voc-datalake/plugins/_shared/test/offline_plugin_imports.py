"""Import a plugin's flat client module (`play_client`, `itunes_client`) for an
offline unit test.

Those modules import `_shared.base_ingestor.logger`. Under pytest the plugins
conftest has already made the real `_shared` importable; for a run that has not
(an isolated import of one test file) a stub carrying only a logger is
registered so the import still succeeds. An already-loaded module is left alone.
"""
import importlib
import logging
import sys
import types
from pathlib import Path


class _BaseIngestorStub(types.ModuleType):
    """A stand-in `_shared.base_ingestor` module that carries only a logger."""

    logger: logging.Logger


def import_plugin_client_offline(test_file: str, module_name: str):
    """Import *module_name* from the directory of *test_file* and return it."""
    _shared = types.ModuleType("_shared")
    _base = _BaseIngestorStub("_shared.base_ingestor")
    _base.logger = logging.getLogger("test")
    sys.modules.setdefault("_shared", _shared)
    sys.modules.setdefault("_shared.base_ingestor", _base)

    sys.path.insert(0, str(Path(test_file).parent))
    return importlib.import_module(module_name)
