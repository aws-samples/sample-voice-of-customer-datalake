"""Mutation hardening for `_shared/github_config.py`.

`github_issues/test/test_github_config.py` pins URL parsing, the creation-date
cut-off and the author-role filter, but a mutation run found what it could not see:

* the ``labels`` and ``product_names`` settings were never read by any test, so
  a misspelt secret key, an inverted ANY-of label match or an ``or`` turned
  ``and`` all passed;
* the caps and boundaries: the 20-repository cap, the 200-character echo of a
  refused entry, and the 2-character minimum for a product name;
* each of GitHub's author associations (only OWNER, MEMBER and
  FIRST_TIME_CONTRIBUTOR were exercised);
* ``parse_repo`` trimming only ``/`` from a bare value, the dataclass being
  frozen and its defaults, and ``canonical_repo`` as a whole.
"""
import dataclasses

import pytest

from _shared.github_config import GitHubSourceConfig, parse_repo


class TestTheRepositoryList:
    def test_keeps_the_first_twenty_repositories(self):
        repos = "\n".join(f"owner/repo{n}" for n in range(21))

        config = GitHubSourceConfig.from_secrets({"repos": repos})

        assert config.repos == tuple(f"owner/repo{n}" for n in range(20))

    def test_a_refused_entry_is_echoed_up_to_200_characters(self):
        pasted = "x" * 250

        config = GitHubSourceConfig.from_secrets({"repos": pasted})

        assert config.rejected_repos == ("x" * 200,)

    def test_a_bare_value_is_trimmed_of_slashes_only(self):
        assert parse_repo("Xowner/nameX") == "Xowner/nameX"

    def test_a_trailing_newline_is_not_part_of_a_valid_repository(self):
        """`$` under `re.match` also matches before a final newline; fullmatch does not."""
        assert parse_repo("owner/name\n") is None


class TestProductNames:
    def test_configured_names_come_first_then_each_repository_name_once(self):
        config = GitHubSourceConfig.from_secrets({
            "repos": "kirodotdev/Kiro, other/CLI",
            "product_names": "Kiro IDE, Kiro",
        })

        assert config.product_names == ("Kiro IDE", "Kiro", "CLI")

    @pytest.mark.parametrize(("name", "kept"), [
        ("Q", ()),
        ("Qd", ("Qd",)),
        ("Qdx", ("Qdx",)),
    ])
    def test_a_name_needs_at_least_two_characters(self, name, kept):
        assert GitHubSourceConfig.from_secrets({"product_names": name}).product_names == kept


class TestLabels:
    def test_labels_are_read_lower_cased(self):
        assert GitHubSourceConfig.from_secrets({"labels": "Bug, Crash"}).labels == frozenset({"bug", "crash"})

    @pytest.mark.parametrize("labels", [[], ["docs"]])
    def test_no_label_filter_admits_every_issue(self, labels):
        assert GitHubSourceConfig.from_secrets({}).admits_labels(labels) is True

    @pytest.mark.parametrize(("labels", "admitted"), [
        (["Bug"], True),
        (["docs", "BUG"], True),
        (["docs"], False),
        ([], False),
    ])
    def test_a_filter_admits_an_issue_with_any_configured_label(self, labels, admitted):
        assert GitHubSourceConfig.from_secrets({"labels": "bug"}).admits_labels(labels) is admitted


class TestAuthorAssociations:
    @pytest.mark.parametrize(("setting", "association"), [
        ("owner", "OWNER"),
        ("member", "MEMBER"),
        ("collaborator", "COLLABORATOR"),
        ("contributor", "CONTRIBUTOR"),
        ("first time contributor", "FIRST_TIME_CONTRIBUTOR"),
        ("first timer", "FIRST_TIMER"),
        ("mannequin", "MANNEQUIN"),
        ("none", "NONE"),
    ])
    def test_every_github_association_can_be_excluded(self, setting, association):
        config = GitHubSourceConfig.from_secrets({"exclude_associations": setting})

        assert config.excluded_associations == frozenset({association})


class TestTheConfigObject:
    @pytest.mark.parametrize("field", ["repos", "created_after"])
    def test_it_is_frozen(self, field):
        config = GitHubSourceConfig.from_secrets({})

        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(config, field, ("a/b",))

    def test_defaults_when_built_directly(self):
        config = GitHubSourceConfig(repos=(), labels=frozenset(), product_names=())

        assert config.rejected_repos == ()
        assert config.created_after is None
        assert config.excluded_associations == frozenset()


class TestCanonicalRepo:
    @pytest.mark.parametrize(("full_name", "canonical"), [
        ("KIRODOTDEV/kiro", "kirodotdev/Kiro"),
        ("other/CLI", "other/CLI"),
        ("kirodotdev/Other", None),
        (None, None),
        (42, None),
    ])
    def test_returns_the_configured_spelling_or_none(self, full_name, canonical):
        config = GitHubSourceConfig.from_secrets({"repos": "kirodotdev/Kiro, other/CLI"})

        assert config.canonical_repo(full_name) == canonical
