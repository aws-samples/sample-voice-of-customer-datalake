"""
Tests for the Kiro export exclusion rules in autoseed_project.

Acceptance criteria covered:
  1. autoseed_project returns no prototype or product_report, even when explicitly requested.
  2. prd, prfaq, research, custom ARE returned; persona selection still works.
  3. The steering file does not mention excluded documents.
  4. GET /projects/{project_id} still returns prototypes in documents.
"""
from unittest.mock import patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_doc(doc_id: str, document_type: str, title: str | None = None) -> dict:
    return {
        'document_id': doc_id,
        'document_type': document_type,
        'title': title or f'Doc {doc_id}',
        'content': f'Content of {doc_id}',
    }


def _make_persona(persona_id: str, name: str = 'Alice') -> dict:
    return {'persona_id': persona_id, 'name': name, 'tagline': 'A persona'}


def _project_data(documents: list[dict], personas: list[dict] | None = None) -> dict:
    return {
        'project': {
            'project_id': 'proj-test',
            'name': 'Test Project',
            'description': 'Desc',
            'kiro_export_prompt': '',
        },
        'personas': personas or [],
        'documents': documents,
    }


# ---------------------------------------------------------------------------
# 1 & 2. autoseed_project filters excluded types; exportable types pass through
# ---------------------------------------------------------------------------

class TestAutoseedExcludesNonExportableTypes:
    """autoseed_project must never include prototype or product_report documents."""

    @patch('projects.get_project')
    def test_prototype_excluded_when_no_ids_filter(self, mock_get_project):
        """Prototype is dropped even when document_ids is None (include-all)."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-prd', 'prd'),
            _make_doc('d-proto', 'prototype'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test')
        doc_types_in_files = {
            f['path'] for f in result['files']
            if f['path'].startswith('.kiro/docs/')
        }
        proto_path = '.kiro/docs/doc-d-proto.md'
        assert any('d-prd' in p or 'prd' in p for p in doc_types_in_files), (
            f'PRD should be exported; files: {doc_types_in_files}'
        )
        assert proto_path not in doc_types_in_files, (
            'Prototype must not appear in Kiro export'
        )

    @patch('projects.get_project')
    def test_product_report_excluded_when_no_ids_filter(self, mock_get_project):
        """Product report is dropped even when document_ids is None."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-prfaq', 'prfaq'),
            _make_doc('d-report', 'product_report'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test')
        doc_paths = [f['path'] for f in result['files'] if f['path'].startswith('.kiro/docs/')]
        assert any('d-report' in p or 'product-report' in p for p in doc_paths) is False, (
            'product_report must not appear in Kiro export'
        )

    @patch('projects.get_project')
    def test_prototype_excluded_even_when_explicitly_requested(self, mock_get_project):
        """A caller who passes a prototype id explicitly must still be denied."""
        proto_id = 'd-proto'
        mock_get_project.return_value = _project_data([
            _make_doc('d-prd', 'prd'),
            _make_doc(proto_id, 'prototype'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test', document_ids=[proto_id, 'd-prd'])
        doc_paths = [f['path'] for f in result['files'] if f['path'].startswith('.kiro/docs/')]
        assert all(proto_id not in p for p in doc_paths), (
            'Prototype must be dropped even when its id is in document_ids'
        )

    @patch('projects.get_project')
    def test_product_report_excluded_even_when_explicitly_requested(self, mock_get_project):
        """A caller who passes a product_report id explicitly must still be denied."""
        report_id = 'd-report'
        mock_get_project.return_value = _project_data([
            _make_doc('d-research', 'research'),
            _make_doc(report_id, 'product_report'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test', document_ids=[report_id, 'd-research'])
        doc_paths = [f['path'] for f in result['files'] if f['path'].startswith('.kiro/docs/')]
        assert all(report_id not in p for p in doc_paths), (
            'product_report must be dropped even when its id is in document_ids'
        )

    @patch('projects.get_project')
    def test_all_excluded_types_produce_no_doc_files(self, mock_get_project):
        """A project with only prototypes and product_reports exports zero doc files."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-proto', 'prototype'),
            _make_doc('d-report', 'product_report'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test')
        doc_files = [f for f in result['files'] if f['path'].startswith('.kiro/docs/')]
        assert doc_files == [], (
            f'No doc files should be emitted; got: {doc_files}'
        )


class TestAutoseedIncludesExportableTypes:
    """All four exportable types (prd, prfaq, research, custom) are passed through."""

    @patch('projects.get_project')
    def test_all_four_exportable_types_are_included(self, mock_get_project):
        """prd, prfaq, research, custom all appear in the payload."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-prd', 'prd', 'My PRD'),
            _make_doc('d-prfaq', 'prfaq', 'My PR/FAQ'),
            _make_doc('d-research', 'research', 'My Research'),
            _make_doc('d-custom', 'custom', 'My Custom'),
            _make_doc('d-proto', 'prototype', 'A Prototype'),
            _make_doc('d-report', 'product_report', 'A Report'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test')
        doc_files = [f for f in result['files'] if f['path'].startswith('.kiro/docs/')]
        assert len(doc_files) == 4, (
            f'Expected 4 exportable docs; got {len(doc_files)}: {[f["path"] for f in doc_files]}'
        )

    @patch('projects.get_project')
    def test_persona_selection_still_works(self, mock_get_project):
        """Persona filtering still honours persona_ids."""
        mock_get_project.return_value = _project_data(
            documents=[_make_doc('d-prd', 'prd')],
            personas=[
                _make_persona('p1', 'Alice'),
                _make_persona('p2', 'Bob'),
            ],
        )

        from projects import autoseed_project

        # Ask for only p1
        result = autoseed_project('proj-test', persona_ids=['p1'])
        persona_files = [f for f in result['files'] if f['path'].startswith('.kiro/personas/')]
        assert len(persona_files) == 1
        assert 'alice' in persona_files[0]['path']

    @patch('projects.get_project')
    def test_exportable_doc_with_explicit_id_is_included(self, mock_get_project):
        """When document_ids is provided, exportable types are included."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-prd', 'prd', 'My PRD'),
            _make_doc('d-other-prd', 'prd', 'Other PRD'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test', document_ids=['d-prd'])
        doc_files = [f for f in result['files'] if f['path'].startswith('.kiro/docs/')]
        assert len(doc_files) == 1


# ---------------------------------------------------------------------------
# 3. Steering file does not mention excluded documents
# ---------------------------------------------------------------------------

class TestSteeringFileExcludesNonExportableDocs:
    """The steering file must not mention prototype or product_report documents."""

    @patch('projects.get_project')
    def test_steering_file_omits_prototype_title(self, mock_get_project):
        """Prototype title does not appear in the steering file."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-prd', 'prd', 'My PRD'),
            _make_doc('d-proto', 'prototype', 'A Secret Prototype'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test')
        steering = next(
            f['content'] for f in result['files']
            if f['path'].startswith('.kiro/steering/')
        )
        assert 'A Secret Prototype' not in steering, (
            'Prototype title must not appear in the steering file'
        )
        assert 'My PRD' in steering, (
            'PRD title should still appear in the steering file'
        )

    @patch('projects.get_project')
    def test_steering_file_omits_product_report_title(self, mock_get_project):
        """Product report title does not appear in the steering file."""
        mock_get_project.return_value = _project_data([
            _make_doc('d-custom', 'custom', 'My Custom Doc'),
            _make_doc('d-report', 'product_report', 'Q4 Product Report'),
        ])

        from projects import autoseed_project

        result = autoseed_project('proj-test')
        steering = next(
            f['content'] for f in result['files']
            if f['path'].startswith('.kiro/steering/')
        )
        assert 'Q4 Product Report' not in steering, (
            'Product report title must not appear in the steering file'
        )
        assert 'My Custom Doc' in steering, (
            'Custom doc title should still appear in the steering file'
        )


# ---------------------------------------------------------------------------
# 4. get_project still returns prototypes in its documents list
# ---------------------------------------------------------------------------

class TestGetProjectStillReturnsPrototypes:
    """get_project must not be changed — it returns ALL document types."""

    @patch('projects.projects_table')
    def test_get_project_includes_prototype(self, mock_table):
        """get_project returns prototype documents unchanged."""
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-1', 'sk': 'META',
                    'project_id': 'proj-1', 'name': 'Test',
                },
                {
                    'pk': 'PROJECT#proj-1', 'sk': 'PROTOTYPE#p1',
                    'document_id': 'p1', 'document_type': 'prototype',
                    'title': 'My Prototype', 'content': '<html/>',
                },
            ]
        }

        from projects import get_project

        result = get_project('proj-1')
        doc_types = [d['document_type'] for d in result['documents']]
        assert 'prototype' in doc_types, (
            'get_project must still return prototype documents (Documents tab depends on it)'
        )

    @patch('projects.projects_table')
    def test_get_project_includes_product_report(self, mock_table):
        """get_project returns product_report documents unchanged."""
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'PROJECT#proj-1', 'sk': 'META',
                    'project_id': 'proj-1', 'name': 'Test',
                },
                {
                    'pk': 'PROJECT#proj-1', 'sk': 'PRODUCT_REPORT#r1',
                    'document_id': 'r1', 'document_type': 'product_report',
                    'title': 'Q4 Report', 'content': '...',
                },
            ]
        }

        from projects import get_project

        result = get_project('proj-1')
        doc_types = [d['document_type'] for d in result['documents']]
        assert 'product_report' in doc_types, (
            'get_project must still return product_report documents (Documents tab depends on it)'
        )
