"""Characterization tests for the project-migration predicates.

Only the pure selection logic is tested here — `is_tombstone` and `is_fixture`
decide which project partitions get copied, and a mistake there silently moves
deleted projects or skips live ones. The AWS-touching copy/rollback paths are
exercised by the live dry-run before any apply (see MIGRATE_PROJECTS_D_TO_F.md),
not mocked here.
"""
import importlib.util
import pathlib

# Load the hyphen-free module directly (scripts/ is not a package).
_spec = importlib.util.spec_from_file_location(
    "migrate_projects",
    pathlib.Path(__file__).with_name("migrate_projects.py"),
)
migrate_projects = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(migrate_projects)

is_tombstone = migrate_projects.is_tombstone
is_fixture = migrate_projects.is_fixture


class TestIsTombstone:
    def test_active_project_is_not_a_tombstone(self):
        assert is_tombstone({"sk": "META", "status": "active"}) is False

    def test_a_meta_with_no_status_is_not_a_tombstone(self):
        # Legacy METAs may omit status; absence must not read as deleted.
        assert is_tombstone({"sk": "META"}) is False

    def test_deleting_status_is_a_tombstone(self):
        assert is_tombstone({"status": "deleting"}) is True

    def test_deleted_status_is_a_tombstone(self):
        assert is_tombstone({"status": "deleted"}) is True

    def test_deletion_started_at_marks_a_tombstone_regardless_of_status(self):
        # The soft-delete fence sets the attribute before the status flips.
        assert is_tombstone({"status": "active", "deletion_started_at": "2026-10-08T00:00:00Z"}) is True


class TestIsFixture:
    def test_marks_rows_carrying_the_fixture_attribute(self):
        assert is_fixture({"verification_fixture_id": "abc"}) is True

    def test_ordinary_project_is_not_a_fixture(self):
        assert is_fixture({"sk": "META", "status": "active"}) is False
