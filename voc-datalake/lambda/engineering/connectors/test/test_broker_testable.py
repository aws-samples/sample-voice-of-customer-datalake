"""The push's checks pinned where its duplicate branch check came out (broker.py ``push_bundle``): the branch is judged
once, before anything is read, and the bundle's changed paths after it, in their own words; the lines a diff adds are
read as code."""
from __future__ import annotations

import pytest

from engineering.connectors.broker import Broker
from engineering.connectors.test.fakes import (
    RUN,
    FakeBundles,
    FakeHost,
    FakeLedger,
    FakeRuns,
    bundle_contents,
    connector,
    record,
)
from engineering.connectors.test.test_broker import caller, push
from engineering.connectors.write_policy import WriteRefused

CI = 'An agent never changes the CI definitions (.github/workflows/ci.yml).'


@pytest.mark.parametrize('branch', ['main', f'voc-agent/{RUN}/', 'voc-agent/OTHER/fix', f'voc-agent/{RUN}/a..b'])
def test_a_push_to_a_branch_not_the_runs_is_refused_before_the_ledger_or_the_patch_is_read(branch: str) -> None:
    bundles, host = FakeBundles(), FakeHost()
    ledger = FakeLedger(set())   # (no GO: had the branch not been judged first, this would answer NotNow)
    with pytest.raises(WriteRefused):
        push(Broker(connector(host=host, bundles=bundles, ledger=ledger)), caller('committer'), branch)
    assert (bundles.read, host.calls) == ([], [])


def test_a_push_of_a_ci_definition_says_only_that_in_its_own_words() -> None:
    bundles = FakeBundles(bundle_contents(changed_paths=('src/a.py', '.github/workflows/ci.yml')))
    host = FakeHost()
    with pytest.raises(WriteRefused) as caught:
        push(Broker(connector(host=host, bundles=bundles)), caller('committer'))
    assert (str(caught.value), host.calls) == (CI, [])


def test_every_ci_definition_a_push_changes_is_named_once_in_order() -> None:
    paths = ('.github/workflows/b.yml', 'src/a.py', '.github/workflows/a.yml', '.github/workflows/b.yml')
    bundles = FakeBundles(bundle_contents(changed_paths=paths))
    with pytest.raises(WriteRefused) as caught:
        push(Broker(connector(bundles=bundles)), caller('committer'))
    assert str(caught.value) == ('An agent never changes the CI definitions (.github/workflows/a.yml). '
                                 'An agent never changes the CI definitions (.github/workflows/b.yml).')


def test_a_run_whose_default_branch_is_its_own_branch_is_still_never_pushed_to() -> None:
    runs = FakeRuns({RUN: record(default_branch=f'voc-agent/{RUN}/fix')})
    host = FakeHost()
    with pytest.raises(WriteRefused) as caught:
        push(Broker(connector(host=host, runs=runs)), caller('committer'), f'voc-agent/{RUN}/fix')
    assert (str(caught.value), host.calls) == ('An agent never pushes to the default branch.', [])


def test_an_added_line_with_an_address_or_a_phone_number_is_code_and_pushed() -> None:
    # (an address on no reserved domain, and a phone number: each refused in prose)
    lines = ('CONTACT = "dev@mail.voc-sample.dev"', 'PHONE = "+1 202 555 0143"')
    host = FakeHost()
    push(Broker(connector(host=host, bundles=FakeBundles(bundle_contents(added_lines=lines)))), caller('committer'))
    assert [call[0] for call in host.calls] == ['push_bundle']
