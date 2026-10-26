"""GitHubSourceConfig: pasted repository URLs, and the creation-date / author-role filters."""
import pytest

from _shared.github_config import GitHubSourceConfig, parse_repo


class TestParseRepo:
    @pytest.mark.parametrize(("pasted", "repo"), [
        ("kirodotdev/KiroCrew", "kirodotdev/KiroCrew"),
        ("/kirodotdev/KiroCrew/", "kirodotdev/KiroCrew"),
        ("kirodotdev/KiroCrew.git", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew/", "kirodotdev/KiroCrew"),
        # Deep links name the repository they are in (the bug: these were dropped).
        ("https://github.com/kirodotdev/KiroCrew/issues", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew/issues/42", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew/issues?q=is%3Aopen+label%3Abug", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew/pulls", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew/tree/main/docs", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew#readme", "kirodotdev/KiroCrew"),
        ("https://github.com/kirodotdev/KiroCrew.git", "kirodotdev/KiroCrew"),
        ("http://www.github.com/kirodotdev/KiroCrew/issues", "kirodotdev/KiroCrew"),
        ("github.com/kirodotdev/KiroCrew/issues", "kirodotdev/KiroCrew"),
        ("HTTPS://GitHub.com/kirodotdev/KiroCrew", "kirodotdev/KiroCrew"),
    ])
    def test_names_the_repository_a_pasted_value_points_at(self, pasted, repo):
        assert parse_repo(pasted) == repo

    @pytest.mark.parametrize("pasted", [
        "not a repo",
        "kirodotdev",
        "kirodotdev/KiroCrew/issues",  # a deep path without a host is a typo, not a link
        "https://github.com/",
        "https://github.com/kirodotdev",
        "https://gitlab.com/kirodotdev/KiroCrew",
        "https://evilgithub.com/kirodotdev/KiroCrew",
        "https://github.com.evil.example/kirodotdev/KiroCrew",
    ])
    def test_refuses_what_names_no_github_repository(self, pasted):
        assert parse_repo(pasted) is None

    def test_from_secrets_keeps_deep_links_and_reports_what_it_refused(self):
        config = GitHubSourceConfig.from_secrets({
            "repos": "https://github.com/kirodotdev/KiroCrew/issues\nkirodotdev/kirocrew\ngitlab.com/a/b, nope",
        })

        assert config.repos == ("kirodotdev/KiroCrew",)
        assert config.rejected_repos == ("gitlab.com/a/b", "nope")


class TestCreatedAfter:
    def test_a_day_becomes_midnight_utc_in_githubs_timestamp_form(self):
        assert GitHubSourceConfig.from_secrets({"created_after": " 2026-03-01 "}).created_after == "2026-03-01T00:00:00Z"

    @pytest.mark.parametrize("value", ["", "   ", "2026-13-01", "yesterday", "01/03/2026", None, 20260301])
    def test_an_unset_or_invalid_date_means_no_lower_bound(self, value):
        config = GitHubSourceConfig.from_secrets({"created_after": value})

        assert config.created_after is None
        assert config.admits_created({"created_at": "2001-01-01T00:00:00Z"})

    @pytest.mark.parametrize(("created_at", "admitted"), [
        ("2026-02-28T23:59:59Z", False),
        ("2026-03-01T00:00:00Z", True),  # on the day counts as after
        ("2026-07-01T12:00:00Z", True),
        (None, True),  # malformed data is not silently dropped
    ])
    def test_admits_only_items_created_on_or_after_the_day(self, created_at, admitted):
        config = GitHubSourceConfig.from_secrets({"created_after": "2026-03-01"})

        assert config.admits_created({"created_at": created_at}) is admitted

    @pytest.mark.parametrize(("watermark", "since"), [
        (None, "2026-03-01T00:00:00Z"),
        ("2026-01-15T10:00:00Z", "2026-03-01T00:00:00Z"),
        ("2026-04-02T08:30:00Z", "2026-04-02T08:30:00Z"),
    ])
    def test_listing_since_is_the_later_of_the_watermark_and_the_day(self, watermark, since):
        assert GitHubSourceConfig.from_secrets({"created_after": "2026-03-01"}).listing_since(watermark) == since

    @pytest.mark.parametrize("watermark", [None, "2026-01-15T10:00:00Z"])
    def test_listing_since_is_the_watermark_without_a_date(self, watermark):
        assert GitHubSourceConfig.from_secrets({}).listing_since(watermark) == watermark


class TestExcludedAssociations:
    def test_parses_case_and_spacing_and_drops_unknown_roles(self):
        config = GitHubSourceConfig.from_secrets({"exclude_associations": "owner, Member,first time contributor, ADMIN"})

        assert config.excluded_associations == frozenset({"OWNER", "MEMBER", "FIRST_TIME_CONTRIBUTOR"})

    @pytest.mark.parametrize(("association", "admitted"), [
        ("MEMBER", False),
        ("member", False),
        ("CONTRIBUTOR", True),
        ("NONE", True),
        (None, True),
    ])
    def test_admits_authors_whose_role_is_not_excluded(self, association, admitted):
        config = GitHubSourceConfig.from_secrets({"exclude_associations": "OWNER, MEMBER"})

        assert config.admits_author({"author_association": association}) is admitted

    def test_no_setting_admits_every_author(self):
        assert GitHubSourceConfig.from_secrets({}).admits_author({"author_association": "OWNER"})

    def test_admits_needs_both_the_role_and_the_date(self):
        config = GitHubSourceConfig.from_secrets({"exclude_associations": "MEMBER", "created_after": "2026-03-01"})
        recent = "2026-05-01T00:00:00Z"

        assert config.admits({"author_association": "NONE", "created_at": recent})
        assert not config.admits({"author_association": "MEMBER", "created_at": recent})
        assert not config.admits({"author_association": "NONE", "created_at": "2025-05-01T00:00:00Z"})
