"""Regression checks for QuickAIPLC documentation and package builders."""

from __future__ import annotations

import json
import posixpath
import re
import subprocess
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
WORKSHOP_ARCHIVE = ROOT / "dist" / "aidlc-discovery.zip"
PLUGIN_ARCHIVE = ROOT / "dist" / "aidlc-discovery.qplugin"
PLUGIN_DIRECTORY = ROOT / "dist" / "aidlc-discovery"
LINK_PATTERN = re.compile(r"(?<!!)\[[^]]*\]\(([^)]+)\)")
HEADING_PATTERN = re.compile(r"^#{1,6}\s+(.+?)\s*$")
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:")
LEGACY_GUIDANCE = (
    "Mode A",
    "Mode B",
    "Mode C",
    "multi-agent workshop system",
    "Double-click the .qplugin",
    "Plugins → Import file",
    "catalog pipeline",
)
GUIDANCE_FILES = (
    "README.md",
    "INSTALL.md",
    "WORKSHOP-SETUP.md",
    "architecture/phase1-signal-analyzer.md",
    "architecture/workshop-flow.md",
    "agents/04-validation/skills/survey-generator.md",
    "build-plugin.sh",
    "build-workshop-zip.sh",
)


def markdown_anchors(text: str) -> set[str]:
    """Return the GitHub-style heading anchors used by local links."""
    anchors: set[str] = set()
    for line in text.splitlines():
        match = HEADING_PATTERN.match(line)
        if not match:
            continue
        heading = re.sub(r"[<>]", "", match.group(1))
        heading = re.sub(r"[^\w\s-]", "", heading.lower())
        anchors.add(re.sub(r"\s+", "-", heading.strip()))
    return anchors


def local_links(text: str) -> list[str]:
    """Return Markdown destinations that should resolve within the package."""
    return [
        destination
        for destination in LINK_PATTERN.findall(text)
        if not destination.startswith(EXTERNAL_PREFIXES)
    ]


def assert_repository_links_resolve(test_case: unittest.TestCase) -> None:
    """Validate every local Markdown target and fragment in the repository."""
    for source in ROOT.rglob("*.md"):
        if any(part in {".git", ".tmp", "dist"} for part in source.parts):
            continue
        text = source.read_text(encoding="utf-8")
        for destination in local_links(text):
            target_text, separator, fragment = destination.partition("#")
            target = (source.parent / target_text).resolve() if target_text else source
            test_case.assertTrue(
                target.exists(),
                f"{source.relative_to(ROOT)} links to missing target {destination}",
            )
            if separator and target.is_file() and target.suffix.lower() == ".md":
                test_case.assertIn(
                    fragment,
                    markdown_anchors(target.read_text(encoding="utf-8")),
                    f"{source.relative_to(ROOT)} links to missing anchor {destination}",
                )


def assert_archive_links_resolve(
    test_case: unittest.TestCase,
    archive: Path,
    skill_prefix: str,
) -> None:
    """Validate local Markdown links after files are placed in an archive."""
    with ZipFile(archive) as zipped:
        names = set(zipped.namelist())
        markdown_names = [
            name
            for name in names
            if name.startswith(skill_prefix) and name.endswith(".md")
        ]
        for source in markdown_names:
            text = zipped.read(source).decode("utf-8")
            for destination in local_links(text):
                target_text, separator, fragment = destination.partition("#")
                target = (
                    posixpath.normpath(
                        posixpath.join(posixpath.dirname(source), target_text)
                    )
                    if target_text
                    else source
                )
                test_case.assertTrue(
                    target in names or f"{target}/" in names,
                    f"{source} links to missing archive target {destination}",
                )
                if separator and target.endswith(".md"):
                    test_case.assertIn(
                        fragment,
                        markdown_anchors(zipped.read(target).decode("utf-8")),
                        f"{source} links to missing archive anchor {destination}",
                    )


class DocumentationAndPackageTests(unittest.TestCase):
    """Exercise the documented default and both distributable packages."""

    @classmethod
    def setUpClass(cls) -> None:
        for script in ("build-workshop-zip.sh", "build-plugin.sh"):
            subprocess.run(
                [str(ROOT / script)],
                cwd=ROOT,
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )

    def test_single_skill_is_the_documented_default(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("The **recommended default** is the `quick-ai-plc` skill", readme)
        self.assertIn("Execution topology and distribution are separate choices", readme)

    def test_current_guidance_avoids_legacy_mode_labels(self) -> None:
        for relative_path in GUIDANCE_FILES:
            text = (ROOT / relative_path).read_text(encoding="utf-8")
            for legacy_text in LEGACY_GUIDANCE:
                self.assertNotIn(legacy_text, text, f"found in {relative_path}")

    def test_repository_local_links_resolve(self) -> None:
        assert_repository_links_resolve(self)

    def test_workshop_archive_preserves_documentation_links(self) -> None:
        self.assertTrue(WORKSHOP_ARCHIVE.is_file())
        assert_archive_links_resolve(self, WORKSHOP_ARCHIVE, "quick-ai-plc/")
        with ZipFile(WORKSHOP_ARCHIVE) as zipped:
            self.assertIn("quick-ai-plc/WORKSHOP-SETUP.md", zipped.namelist())
            self.assertIn("quick-ai-plc/SKILL.md", zipped.namelist())

    def test_workshop_archive_excludes_development_artifacts(self) -> None:
        with ZipFile(WORKSHOP_ARCHIVE) as zipped:
            names = zipped.namelist()
        offending = [
            name
            for name in names
            if name.startswith("quick-ai-plc/tests/")
            or "__pycache__" in name
            or name.endswith((".pyc", ".gitkeep", "build-plugin.sh", "build-workshop-zip.sh"))
        ]
        self.assertEqual([], offending)

    def test_plugin_outputs_equivalent_importable_folder_and_archive(self) -> None:
        self.assertTrue(PLUGIN_DIRECTORY.is_dir())
        self.assertTrue(PLUGIN_ARCHIVE.is_file())
        assert_archive_links_resolve(self, PLUGIN_ARCHIVE, "skills/quick-ai-plc/")

        folder_files = {
            path.relative_to(PLUGIN_DIRECTORY).as_posix()
            for path in PLUGIN_DIRECTORY.rglob("*")
            if path.is_file()
        }
        with ZipFile(PLUGIN_ARCHIVE) as zipped:
            archive_files = {
                name for name in zipped.namelist() if not name.endswith("/")
            }
        self.assertEqual(folder_files, archive_files)

        manifest = json.loads(
            (PLUGIN_DIRECTORY / "plugin.json").read_text(encoding="utf-8")
        )
        self.assertEqual("0.1", manifest["format_version"])
        self.assertFalse((PLUGIN_DIRECTORY / "agents").exists())
        self.assertTrue(
            (PLUGIN_DIRECTORY / "skills" / "quick-ai-plc" / "SKILL.md").is_file()
        )
        self.assertFalse((PLUGIN_DIRECTORY / "skills" / "quick-ai-plc" / "tests").exists())
        self.assertFalse(
            (PLUGIN_DIRECTORY / "skills" / "quick-ai-plc" / "build-workshop-zip.sh").exists()
        )
        self.assertFalse(any(PLUGIN_DIRECTORY.rglob("*.pyc")))

    def test_plugin_name_rejects_path_traversal(self) -> None:
        result = subprocess.run(
            [str(ROOT / "build-plugin.sh"), "../outside-dist"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(2, result.returncode)
        self.assertIn("Plugin name must start", result.stderr)

    def test_build_staging_is_cleaned(self) -> None:
        build_root = ROOT / ".tmp"
        self.assertFalse(build_root.exists() and any(build_root.iterdir()))


if __name__ == "__main__":
    unittest.main()
