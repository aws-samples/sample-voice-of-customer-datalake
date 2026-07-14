"""
Tests for date_basis threading through the MCP search_feedback tool (issue #150).
"""
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestMcpSearchFeedbackDateBasis:
    @patch('mcp_handler.query_feedback_by_date')
    @patch('mcp_handler.feedback_table')
    def test_passes_validated_date_basis_to_shared_query(self, _mock_table, mock_query):
        mock_query.return_value = []
        from mcp_handler import _tool_search_feedback

        _tool_search_feedback({'days': 7, 'date_basis': 'review'}, {})

        assert mock_query.call_args.kwargs['date_basis'] == 'review'

    @patch('mcp_handler.query_feedback_by_date')
    @patch('mcp_handler.feedback_table')
    def test_defaults_to_imported_basis(self, _mock_table, mock_query):
        mock_query.return_value = []
        from mcp_handler import _tool_search_feedback

        _tool_search_feedback({'days': 7}, {})

        assert mock_query.call_args.kwargs['date_basis'] == 'imported'

    @patch('mcp_handler.query_feedback_by_date')
    @patch('mcp_handler.feedback_table')
    def test_invalid_basis_falls_back_to_imported(self, _mock_table, mock_query):
        """LLM-supplied args are untrusted; anything off the allowlist
        degrades to the default instead of erroring the tool call."""
        mock_query.return_value = []
        from mcp_handler import _tool_search_feedback

        _tool_search_feedback({'days': 7, 'date_basis': 'DROP TABLE'}, {})

        assert mock_query.call_args.kwargs['date_basis'] == 'imported'

    def test_tool_schema_declares_date_basis_enum(self):
        from mcp_handler import MCP_TOOLS

        search_tool = next(t for t in MCP_TOOLS if t['name'] == 'search_feedback')
        prop = search_tool['inputSchema']['properties']['date_basis']
        assert prop['enum'] == ['imported', 'review']
        assert prop['default'] == 'imported'
