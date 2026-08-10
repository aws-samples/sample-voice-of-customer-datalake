"""`item_to_widget_config` and `FeedbackFormConfig` must describe the same body.

`GET /feedback-forms/<id>/config` is registered without `authMethodOptions`
(`lib/stacks/api-stack.ts`, "Intentionally unauthenticated: the widget runs on
the customer's own site") and is fetched cross-origin by the embedded widget. It
is served by its own narrow allowlist, `item_to_widget_config`, rather than the
`item_to_form` projection the authenticated routes use — deliberately, so that a
field added to `item_to_form` cannot leak by default.

That split creates two ways to drift, in opposite directions and both silent:

- A field declared on `FeedbackFormConfig` but absent from the dict is a lie the
  compiler believes. The frontend reads `config.x`, gets `undefined`, and TypeScript
  never says so.
- A field added to the dict but not to the type publishes something on an
  unauthenticated route that no reviewer of `types.ts` ever saw.

Neither language can see the other, so this test reads the TypeScript
declaration directly — the same lockstep approach as
`test_feedback_page_limit_lockstep.py`.
"""
import re
from pathlib import Path

import pytest


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


TYPES_SOURCE = 'frontend/src/api/types.ts'


def _interface_body(source: str, name: str) -> str:
    """The body of one `interface X { ... }` declaration, comments stripped."""
    start = source.find(f'interface {name} ')
    assert start != -1, f'interface {name} not found in {TYPES_SOURCE} — renamed?'
    open_brace = source.index('{', start)
    close = source.index('\n}', open_brace)
    body = source[open_brace:close]
    body = re.sub(r'/\*[\s\S]*?\*/', '', body)
    return re.sub(r'//[^\n]*', '', body)


def _declared_config_fields() -> set[str]:
    """Field names on `FeedbackFormConfig`, including its inherited base.

    Only top-level members count: a nested object's own keys (`theme`'s colours,
    `custom_fields`' entries) are not fields of the response body.
    """
    path = _repo_root() / TYPES_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing
        # to compare, and skipping beats a failure that says nothing about the
        # code under test.
        pytest.skip(f'{TYPES_SOURCE} not present in this tree')
    source = path.read_text(encoding='utf-8')

    fields: set[str] = set()
    for name in ('FeedbackFormConfig', 'FeedbackFormFields'):
        declared_here = set()
        for line in _interface_body(source, name).split('\n'):
            # Top-level members are indented exactly two spaces; anything deeper
            # belongs to a nested object literal.
            #
            # `readonly` is matched explicitly rather than left out: a member the
            # pattern fails to recognise drops out of `declared`, and in the
            # "declared but not served" direction that makes the comparison below
            # PASS — i.e. the extractor fails OPEN on exactly one of the two
            # drifts this test exists to catch. (Proven by probe: marking one
            # served member `readonly` and removing it from the dict passed.)
            match = re.fullmatch(r'  (?:readonly )?(\w+)\??:.*', line.rstrip())
            if match:
                declared_here.add(match.group(1))
        # An empty result means the extractor stopped recognising members — a
        # reformat, a modifier it does not know — not that the interface is
        # empty. Left unchecked that also fails open, silently.
        assert declared_here, (
            f'extracted no members from interface {name} in {TYPES_SOURCE}. '
            'The declaration was probably reformatted, or a member modifier '
            'this parser does not handle was introduced. Fix the pattern — an '
            'empty set would make the comparison below vacuous.'
        )
        fields |= declared_here
    return fields


class TestWidgetConfigTypeLockstep:
    def test_public_projection_matches_the_declared_type_exactly(
        self, feedback_form_handler
    ):
        served = set(feedback_form_handler.item_to_widget_config({}))
        declared = _declared_config_fields()

        assert served == declared, (
            'item_to_widget_config and FeedbackFormConfig have drifted.\n'
            f'  served but not declared: {sorted(served - declared)}\n'
            f'  declared but not served: {sorted(declared - served)}\n'
            'The first publishes a field on an UNAUTHENTICATED route that no '
            'reviewer of types.ts saw; the second makes the frontend read '
            'undefined from a field the compiler swears exists. Change both, or '
            'neither.\n'
            f'If neither list looks wrong, {TYPES_SOURCE} was probably '
            'reformatted: this assertion reads the TypeScript declaration as '
            'text, so a member reflowed onto a continuation line or given a '
            'modifier stops being recognised.'
        )

    def test_the_link_fields_are_in_neither(self, feedback_form_handler):
        """The reason the split exists, asserted from both sides at once."""
        served = set(feedback_form_handler.item_to_widget_config({}))
        declared = _declared_config_fields()

        for field in ('project_id', 'document_id'):
            assert field not in served, f'{field} must not be served publicly'
            assert field not in declared, f'{field} must not be declared public'
