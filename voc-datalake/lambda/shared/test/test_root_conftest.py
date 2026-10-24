"""The rootdir conftest closes the X-Ray SDK's UDP socket, so a test run ends without a ResourceWarning."""
import importlib.util
import socket
import subprocess
import sys
import textwrap
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


def _root_conftest() -> ModuleType:
    """voc-datalake/conftest.py, loaded under its own name (``conftest`` is taken by every tree)."""
    spec = importlib.util.spec_from_file_location('voc_root_conftest', ROOT / 'conftest.py')
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_sdk(udp_socket: object) -> SimpleNamespace:
    return SimpleNamespace(xray_recorder=SimpleNamespace(emitter=SimpleNamespace(_socket=udp_socket)))


class TestCloseXrayEmitterSocket:
    def test_closes_the_recorder_socket_once(self) -> None:
        close = _root_conftest().close_xray_emitter_socket
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        with patch.dict(sys.modules, {'aws_xray_sdk.core': _fake_sdk(udp)}):
            first, second = close(), close()
        assert (first, second) == (True, False)
        assert udp.fileno() == -1

    def test_does_nothing_when_the_sdk_was_never_loaded(self) -> None:
        close = _root_conftest().close_xray_emitter_socket
        with patch.dict(sys.modules):
            sys.modules.pop('aws_xray_sdk.core', None)
            closed = close()
            loaded = 'aws_xray_sdk.core' in sys.modules
        assert (closed, loaded) == (False, False)

    def test_ignores_an_emitter_without_a_real_socket(self) -> None:
        close = _root_conftest().close_xray_emitter_socket
        with patch.dict(sys.modules, {'aws_xray_sdk.core': _fake_sdk('not a socket')}):
            closed = close()
        assert closed is False

    def _session(self, tmp_path: Path, plugin: str) -> subprocess.CompletedProcess[str]:
        """One pytest session over a test that imports the SDK; ``plugin`` is ``conftest`` or ``no:conftest``."""
        (tmp_path / 'test_imports_sdk.py').write_text(textwrap.dedent('''
            def test_imports_the_sdk():
                import aws_xray_sdk.core  # noqa: F401
        '''))
        return subprocess.run(
            [sys.executable, '-W', 'always', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-p', plugin, str(tmp_path)],
            capture_output=True, text=True, check=False, cwd=tmp_path,
            env={'PYTHONPATH': str(ROOT), 'PATH': '/usr/bin:/bin'},
        )

    def test_a_bare_session_reports_the_leak(self, tmp_path: Path) -> None:
        # Positive control: without the hook the same session does warn, so the check below can fail.
        result = self._session(tmp_path, 'no:conftest')
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'unclosed <socket.socket' in result.stderr

    def test_a_session_that_imports_the_sdk_ends_without_a_resource_warning(self, tmp_path: Path) -> None:
        result = self._session(tmp_path, 'conftest')
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'unclosed <socket.socket' not in result.stderr
