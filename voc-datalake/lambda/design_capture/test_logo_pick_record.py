"""The picked logo in a capture (7.01.00): photographed AFTER the design shots, once the page is back at the top and
its header had ``HEADER_SETTLE_SECONDS``, and stored with how it was picked (``picked_by`` / ``pick_model``).
A fake CDP connection; no AWS but moto, no model.
"""
import boto3
import capture_worker as cw
import pytest
from logo_isolate import ISOLATE_JS
from page_logo import PageLogo
from test_design_capture_worker import (  # noqa: F401 - fixture
    ISOLATED_BOX,
    TRIMMED_PNG,
    LogoAnswers,
    _run,
    _styles,
    candidate,
    page_candidates,
    table,
    trim_answer,
)
from test_logo_pick import PICK_MODEL
from test_page_shots import REGIONS, SCROLLED, ShotCdp

SCROLL_TOP = "window.scrollTo({ top: 0, left: 0, behavior: 'instant' })"


@pytest.fixture
def s3(table):  # noqa: F811 — pytest fixture parameter named like the imported fixture
    del table
    client = boto3.client('s3', region_name='us-east-1')
    client.create_bucket(Bucket='raw')
    return client


def _page() -> ShotCdp:
    """A page with a header and a footer (three design shots) whose one candidate the rules take and isolate."""
    return ShotCdp(_styles(), regions=[REGIONS, SCROLLED], logo=LogoAnswers(
        candidates=page_candidates(candidate()), isolate=ISOLATED_BOX, trim=trim_answer(TRIMMED_PNG)))


def _index(cdp: ShotCdp, expression: str, *, last_before: int | None = None) -> int:
    """Where the first ``Runtime.evaluate`` of ``expression`` (a prefix for ISOLATE_JS) sits in the calls; with
    ``last_before``, the last one before that index."""
    found = [i for i, (m, p) in enumerate(cdp.calls)
             if m == 'Runtime.evaluate' and str(p.get('expression')).startswith(expression)]
    return found[0] if last_before is None else max(i for i in found if i < last_before)


class TestTheLogoIsPhotographedLast:
    def test_the_isolating_evaluate_comes_after_the_fold_header_and_footer_shots(self, table, s3):  # noqa: F811
        cdp = _page()
        _, stored, vision, _ = _run(table, cdp, s3=s3)
        isolating = _index(cdp, f'({ISOLATE_JS})')
        shots = [i for i, ((m, _), (s, _)) in enumerate(zip(cdp.calls, cdp.routed, strict=True))
                 if m == 'Page.captureScreenshot' and s == 's1' and i < isolating]
        assert len(shots) == 4             # the marked header (for the pick), then fold, header, footer: all before
        assert [s.region for s in vision.call_args.args[0]] == ['fold', 'header', 'footer']
        assert stored['extracted_design']['logo']['rendered'] is True

    def test_scrolls_to_the_top_and_waits_for_the_header_before_isolating(self, table, s3):  # noqa: F811
        cdp = _page()
        waits: list[tuple[float, int]] = []
        _run(table, cdp, s3=s3, sleep=lambda seconds: waits.append((seconds, len(cdp.calls))))
        isolating = _index(cdp, f'({ISOLATE_JS})')
        scrolled = _index(cdp, SCROLL_TOP, last_before=isolating)
        # the page-load poll may wait as long earlier; exactly one such wait sits between the scroll and the isolation
        settle = [at for seconds, at in waits if seconds == cw.HEADER_SETTLE_SECONDS and scrolled < at <= isolating]
        assert len(settle) == 1
        footer_shot = max(i for i, (m, _) in enumerate(cdp.calls[:isolating]) if m == 'Page.captureScreenshot')
        assert footer_shot < scrolled

    def test_stores_that_the_rules_picked_it_and_no_model(self, table, s3):  # noqa: F811
        _, stored, _, _ = _run(table, _page(), s3=s3)
        logo = stored['extracted_design']['logo']
        assert logo['picked_by'] == 'rules'
        assert 'pick_model' not in logo


class TestWithPickRecord:
    def test_adds_the_pick_and_the_model_to_the_stored_logo(self):
        design = {'summary': 'S', 'logo': {'source_url': 'https://kirocrew.dev/l.png'}}
        logo = PageLogo(picked_by='model', pick_model=PICK_MODEL)
        assert cw.with_pick_record(design, logo) == {'summary': 'S', 'logo': {
            'source_url': 'https://kirocrew.dev/l.png', 'picked_by': 'model', 'pick_model': PICK_MODEL}}

    def test_adds_no_model_for_a_rules_pick(self):
        design = {'logo': {'source_url': 'https://kirocrew.dev/l.png'}}
        assert cw.with_pick_record(design, PageLogo(picked_by='rules')) == {
            'logo': {'source_url': 'https://kirocrew.dev/l.png', 'picked_by': 'rules'}}

    @pytest.mark.parametrize('design', [{'summary': 'S'}, {'logo': None}, None],
                             ids=['no-logo', 'logo-none', 'no-design'])
    def test_records_nothing_when_no_logo_was_stored(self, design):
        assert cw.with_pick_record(design, PageLogo(picked_by='model', pick_model='m')) == design

    def test_records_nothing_for_a_logo_nobody_picked(self):
        design = {'logo': {'source_url': 'https://kirocrew.dev/l.png'}}
        assert cw.with_pick_record(design, PageLogo()) == design
