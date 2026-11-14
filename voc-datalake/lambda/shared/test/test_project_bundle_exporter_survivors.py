"""Examples of the project export's edges the properties do not reach (scripts/project_bundle/exporter.py).

The refusal each operator reads, an object read that fails for another reason than a missing key, and the section
counts in a process that has only `scripts/` on its path (the export's own: standard library and boto3).
"""
from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Any

import pytest
from botocore.exceptions import ClientError

from shared.test.test_project_bundle_exporter_properties import load_exporter

if TYPE_CHECKING:
    from botocore.exceptions import _ClientErrorResponseTypeDef

PID = 'proj_20260101000000_aaaa1111'


@pytest.fixture(scope='module')
def ex() -> Iterator[ModuleType]:
    """`project_bundle.exporter`, imported the way scripts/project-export.py imports it (scripts/ on sys.path)."""
    yield from load_exporter()


class FakeTable:
    def __init__(self, meta: dict[str, Any] | None) -> None:
        self.meta = meta

    def get_item(self, *, Key: dict[str, Any], ConsistentRead: bool) -> dict[str, Any]:
        assert Key == {'pk': f'PROJECT#{PID}', 'sk': 'META'}
        assert ConsistentRead is True
        return {} if self.meta is None else {'Item': self.meta}


class TestTheRefusalSaysWhy:
    @pytest.mark.parametrize(('meta', 'message'), [
        (None, f'project {PID} does not exist on the source deployment'),
        ({'status': 'deleting'}, f'project {PID} is deleted (tombstone); nothing to export'),
        ({'deletion_started_at': '2026-01-01T00:00:00Z'}, f'project {PID} is deleted (tombstone); nothing to export'),
        ({'kind': 'company_personas'}, f'{PID} is a reserved container (company_personas), not a project'),
    ])
    def test_each_refusal_names_the_project_and_the_reason(self, ex: ModuleType, meta: dict | None,
                                                            message: str) -> None:
        with pytest.raises(ex.ExportError) as refused:
            ex._meta(FakeTable(meta), PID)
        assert str(refused.value) == message

    def test_a_live_meta_is_returned_as_stored(self, ex: ModuleType) -> None:
        meta = {'pk': f'PROJECT#{PID}', 'sk': 'META', 'name': 'Checkout', 'status': 'active'}
        assert ex._meta(FakeTable(meta), PID) == meta


class FailingS3:
    """A bucket whose every read fails with `error` (a ClientError's response)."""

    def __init__(self, error: _ClientErrorResponseTypeDef) -> None:
        self.error = error

    def get_object(self, **_request: Any) -> dict[str, Any]:
        raise ClientError(self.error, 'GetObject')


class TestAnObjectReadThatFails:
    @pytest.mark.parametrize('code', ['NoSuchKey', '404'])
    def test_a_missing_object_is_skipped(self, ex: ModuleType, code: str) -> None:
        s3 = FailingS3({'Error': {'Code': code}})
        assert ex._object_record(s3, 'src-bucket', PID, 'avatars/p1/a.png') is None

    @pytest.mark.parametrize('error', [{'Error': {'Code': 'AccessDenied'}}, {'Error': {'Code': '403'}}, {}],
                             ids=['denied', 'forbidden', 'no-error-body'])
    def test_any_other_failure_stops_the_export(self, ex: ModuleType, error: _ClientErrorResponseTypeDef) -> None:
        with pytest.raises(ClientError):
            ex._object_record(FailingS3(error), 'src-bucket', PID, 'prototypes/x/a.html')


class TestTheCountsNeedOnlyTheScriptsDirectory:
    def test_the_section_counts_run_with_only_scripts_on_the_path(self, ex: ModuleType) -> None:
        """The export runs with scripts/ on its path and nothing of the Lambda tree; the counts find the section
        table themselves (lambda/shared/document_sections.py, standard library only)."""
        assert ex.__file__ is not None
        scripts = str(Path(ex.__file__).resolve().parents[1])
        program = (
            'import sys\n'
            f'sys.path.insert(0, {scripts!r})\n'
            'from project_bundle.exporter import document_section_counts\n'
            f'rows = [{{"pk": "PROJECT#{PID}", "sk": "PRD#d1", "document_type": "prd"}},'
            f' {{"pk": "PROJECT#{PID}", "sk": "PROTOTYPE#p1"}}]\n'
            f'print(sorted(document_section_counts({PID!r}, rows).items()))\n'
        )
        env = {key: value for key, value in os.environ.items() if not key.startswith('PYTHON')}
        done = subprocess.run(  # noqa: S603 (this interpreter, a fixed program)
            [sys.executable, '-I', '-c', program], capture_output=True, text=True, env=env, timeout=120, check=False)
        assert done.returncode == 0, done.stderr
        assert done.stdout.strip().splitlines()[-1] == "[('documents', 0), ('prd', 1), ('prfaq', 0), ('prototypes', 1)]"
