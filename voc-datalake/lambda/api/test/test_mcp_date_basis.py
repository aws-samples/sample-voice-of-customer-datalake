"""
Tests for date_basis threading through the MCP search_feedback tool (issue #150).

The tool delegates now, so what "threading" means has moved: it used to pass a
locally-validated `date_basis` into the shared query helper, and it now forwards
the caller's value to the route as a query-string parameter, where
`validate_date_basis` is applied by the same code path every other client of
`GET /feedback` goes through.

That relocation is the point rather than an accident. The adapter validating
first would be a second implementation of the allowlist — the class of drift the
delegation change exists to remove — and the route cannot skip its own check,
because the browser hits it directly too.
"""
import io
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _stub_client():
    """A domain function that answers with an empty feedback page."""
    client = MagicMock()
    client.invoke.side_effect = lambda **_kwargs: {
        "Payload": io.BytesIO(json.dumps({
            "statusCode": 200,
            "body": json.dumps({"count": 0, "items": []}),
        }).encode()),
    }
    return client


def _search(args: dict) -> dict:
    """Run search_feedback and return the query string the route received."""
    import mcp_handler
    client = _stub_client()
    with patch("shared.mcp_delegate.get_lambda_client", return_value=client), \
         patch.dict(os.environ, {"METRICS_FUNCTION": "voc-metrics-api"}):
        mcp_handler._tool_search_feedback(args, {"token_id": "tok_1"})
    event = json.loads(client.invoke.call_args.kwargs["Payload"])
    return event.get("queryStringParameters") or {}


class TestMcpSearchFeedbackDateBasis:
    def test_passes_date_basis_to_the_route(self):
        assert _search({"days": 7, "date_basis": "review"})["date_basis"] == "review"

    def test_omits_date_basis_when_the_caller_gave_none(self):
        """Absence is forwarded as absence, not as an invented default.

        The route's own default is 'imported'; sending it explicitly would mean
        two places deciding the same thing, and the adapter's copy would be the
        one that goes stale.
        """
        assert "date_basis" not in _search({"days": 7})

    def test_an_off_allowlist_basis_is_forwarded_for_the_route_to_degrade(self):
        """LLM-supplied args are untrusted, and the refusal still happens — one
        layer further in.

        `validate_date_basis` on the route degrades anything off the allowlist to
        'imported' (pinned by the metrics-handler date-basis tests), so the
        caller-visible behaviour is unchanged. What this test protects is that
        the adapter does not quietly "fix" the value first: a value silently
        corrected here would hide a client bug that the route reports honestly,
        and would drift the moment the allowlist gains a member.
        """
        assert _search({"days": 7, "date_basis": "DROP TABLE"})["date_basis"] == "DROP TABLE"

    def test_the_route_still_rejects_what_the_adapter_forwards(self):
        """The other half of the invariant above, asserted rather than assumed.

        Without this, "the adapter forwards it" and "somebody validates it" are
        two claims with a gap between them wide enough for an injection.
        """
        from shared.api import validate_date_basis

        assert validate_date_basis("DROP TABLE") == "imported"
        assert validate_date_basis(None) == "imported"
        assert validate_date_basis("review") == "review"

    def test_tool_schema_declares_date_basis_enum(self):
        from mcp_handler import MCP_TOOLS

        search_tool = next(t for t in MCP_TOOLS if t['name'] == 'search_feedback')
        prop = search_tool['inputSchema']['properties']['date_basis']
        assert prop['enum'] == ['imported', 'review']
        assert prop['default'] == 'imported'
