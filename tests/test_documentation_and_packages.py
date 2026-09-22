"""Regression checks for the AIDLC: Discovery package shape and documentation.

The repository root is the installable package for Amazon Quick (plugin v0.1),
Kiro (Agent Plugins 1.0.0), and Claude Code (plugin manifest). These tests pin
the contract each loader reads so a refactor cannot silently break one harness.
Run with: python3 -m unittest discover tests
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL_NAME = "aidlc-discovery"
SKILL_DIR = ROOT / "skills" / SKILL_NAME
PLUGIN_NAME = "aidlc-discovery"

LINK_PATTERN = re.compile(r"(?<!!)\[[^]]*\]\(([^)]+)\)")
HEADING_PATTERN = re.compile(r"^#{1,6}\s+(.+?)\s*$")
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:")
SKIP_DIRS = {".git", ".tmp", "dist", "__pycache__"}

# Agent Plugins 1.0.0 §5.5 and Agent Skills `name` constraints.
AGENT_PLUGINS_NAME = re.compile(r"^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
AGENT_SKILLS_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
KIRO_REQUIRED_KEYS = {"$schema", "name", "version", "description", "author", "keywords"}
QUICK_REQUIRED_KEYS = {"id", "name", "version", "format_version", "description", "created_at"}

# Quick tool names are allowed only inside the one harness table in SKILL.md
# (and in Quick's own frontmatter `tools:` list); everywhere else the prompts
# must speak in capabilities so Kiro and Claude Code can follow them.
QUICK_TOOL_NAMES = ("file_rag_search", "file_read_pdf", "file_read_docx", "run_python", "open_in_session_tab")
HARNESS_TABLE_HEADING = "## Working Across Harnesses"

LEGACY_GUIDANCE = (
    "Mode A",
    "Mode B",
    "Mode C",
    "multi-agent workshop system",
    "Double-click the .qplugin",
    "Plugins → Import file",
    "catalog pipeline",
    "build-plugin.sh",
    "build-workshop-zip.sh",
    "quick-ai-plc/",
    "quick-aidlc-discovery/",
)
GUIDANCE_FILES = (
    "README.md",
    "INSTALL.md",
    "WORKSHOP-SETUP.md",
    "architecture/phase1-signal-analyzer.md",
    "architecture/workshop-flow.md",
    f"skills/{SKILL_NAME}/agents/04-validation/skills/survey-generator.md",
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


def skill_frontmatter(text: str) -> dict[str, str]:
    """Return the top-level scalar frontmatter fields of a SKILL.md.

    A deliberately small parser: `key: value` lines at column 0 start a field
    and indented continuation lines (folded `>-` blocks, nested maps such as
    `metadata:`, the Quick `patterns:` list) are appended to the preceding
    key. Only the scalar fields the tests assert on need to be exact.
    """
    assert text.startswith("---\n"), "frontmatter must open on the first line"
    block = text.split("\n---\n", 1)[0][4:]
    fields: dict[str, str] = {}
    key = None
    for line in block.splitlines():
        if line.startswith("#"):
            continue
        if line and not line[0].isspace():
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
        elif key is not None and line.strip():
            fields[key] = (fields[key] + " " + line.strip()).strip()
    for key, value in fields.items():
        if value.startswith(">-"):
            fields[key] = value[2:].strip()
    return fields


def repository_markdown() -> list[Path]:
    return [
        path
        for path in ROOT.rglob("*.md")
        if not any(part in SKIP_DIRS for part in path.parts)
    ]


class PackageShapeTests(unittest.TestCase):
    """The repository root must be importable by all three harnesses as-is."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
        cls.claude_manifest = json.loads(
            (ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        cls.marketplace = json.loads(
            (ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
        )
        cls.skill_text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
        cls.frontmatter = skill_frontmatter(cls.skill_text)

    def test_root_manifest_serves_kiro_and_quick(self) -> None:
        self.assertEqual(AGENT_PLUGINS_SCHEMA, self.manifest["$schema"])
        self.assertRegex(self.manifest["name"], AGENT_PLUGINS_NAME)
        self.assertEqual(PLUGIN_NAME, self.manifest["name"])
        self.assertTrue(KIRO_REQUIRED_KEYS <= self.manifest.keys(), KIRO_REQUIRED_KEYS - self.manifest.keys())
        self.assertTrue(QUICK_REQUIRED_KEYS <= self.manifest.keys(), QUICK_REQUIRED_KEYS - self.manifest.keys())
        self.assertEqual("0.1", self.manifest["format_version"])
        self.assertEqual(PLUGIN_NAME, self.manifest["id"])
        self.assertIsInstance(self.manifest["keywords"], list)
        self.assertEqual({"name", "url"}, set(self.manifest["author"]))  # author object is closed in the spec

    def test_quick_companion_files_are_present(self) -> None:
        for name in ("mcps.json", "tasks.json"):
            self.assertEqual([], json.loads((ROOT / name).read_text(encoding="utf-8")), name)

    def test_claude_manifest_and_marketplace(self) -> None:
        self.assertEqual(PLUGIN_NAME, self.claude_manifest["name"])
        self.assertRegex(self.claude_manifest["name"], AGENT_SKILLS_NAME)
        agents_path = self.claude_manifest["agents"]
        self.assertTrue(agents_path.startswith("./"), agents_path)
        self.assertTrue((ROOT / agents_path).is_dir(), agents_path)
        entry = self.marketplace["plugins"][0]
        self.assertEqual(PLUGIN_NAME, entry["name"])
        self.assertEqual("./", entry["source"])
        self.assertRegex(self.marketplace["name"], AGENT_SKILLS_NAME)

    def test_versions_agree_across_manifests_and_changelog(self) -> None:
        version = self.manifest["version"]
        self.assertEqual(version, self.claude_manifest["version"])
        self.assertIn(f'version: "{version}"', self.skill_text)
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        self.assertIn(f"## {version} — ", changelog)

    def test_skill_frontmatter_follows_the_agent_skills_standard(self) -> None:
        self.assertEqual(SKILL_NAME, self.frontmatter["name"])
        self.assertEqual(SKILL_DIR.name, self.frontmatter["name"])  # Kiro: name must match the folder
        self.assertRegex(self.frontmatter["name"], AGENT_SKILLS_NAME)
        self.assertLessEqual(len(self.frontmatter["name"]), 64)
        self.assertTrue(0 < len(self.frontmatter["description"]) <= 1024, len(self.frontmatter["description"]))
        self.assertLessEqual(len(self.frontmatter["compatibility"]), 500)
        self.assertIn("license", self.frontmatter)
        self.assertIn("## Overview", self.skill_text)  # Quick's validator requires it
        self.assertLess(self.skill_text.count("\n"), 500)

    def test_skill_prose_names_capabilities_not_quick_tools(self) -> None:
        body = self.skill_text.split("\n---\n", 1)[1]
        before_table, _, _ = body.partition(HARNESS_TABLE_HEADING)
        for tool in QUICK_TOOL_NAMES:
            self.assertNotIn(tool, before_table, f"{tool} used as an instruction outside the harness table")
        for path in SKILL_DIR.rglob("*.md"):
            if path.name == "SKILL.md":
                continue
            text = path.read_text(encoding="utf-8")
            for tool in QUICK_TOOL_NAMES:
                for line in text.splitlines():
                    if tool in line:
                        self.assertIn("Quick:", line, f"{path.relative_to(ROOT)} uses {tool} without naming the harness")

    def test_skill_reference_prompts_exist(self) -> None:
        referenced = set(re.findall(r"`(agents/[^`]+\.(?:md|html))`", self.skill_text))
        self.assertGreaterEqual(len(referenced), 15)
        for relative in sorted(referenced):
            self.assertTrue((SKILL_DIR / relative).is_file(), relative)
        self.assertTrue((SKILL_DIR / "config.default.md").is_file())
        self.assertTrue((SKILL_DIR / "knowledge-base" / "voc-data" / "example-feedback.json").is_file())

    def test_no_stray_markdown_where_claude_scans_for_agents(self) -> None:
        # A root agents/ directory would be scanned recursively by Claude Code.
        self.assertFalse((ROOT / "agents").exists())
        self.assertFalse((ROOT / "SKILL.md").exists())


class DedicatedAgentTests(unittest.TestCase):
    """The optional Kiro and Claude Code agents must point at real prompts."""

    def test_kiro_and_claude_agent_sets_match(self) -> None:
        kiro = sorted(p.stem for p in (ROOT / ".kiro" / "agents").glob("*.json"))
        claude = sorted(p.stem for p in (ROOT / ".claude" / "agents").glob("*.md"))
        self.assertEqual(kiro, claude)
        self.assertEqual(11, len(kiro))

    def test_kiro_agents_resolve_prompt_and_subagents(self) -> None:
        agent_dir = ROOT / ".kiro" / "agents"
        names = {p.stem for p in agent_dir.glob("*.json")}
        for path in sorted(agent_dir.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(path.stem, data["name"])
            prompt = data["prompt"]
            self.assertTrue(prompt.startswith("file://"), prompt)
            self.assertTrue((agent_dir / prompt[len("file://"):]).resolve().is_file(), prompt)
            for resource in data.get("resources", []):
                self.assertTrue((ROOT / resource.split("://", 1)[1]).is_file(), resource)
            subs = data.get("toolsSettings", {}).get("subagent", {}).get("availableAgents", [])
            if subs:
                self.assertIn("subagent", data["tools"])
                self.assertTrue(set(subs) <= names, set(subs) - names)

    def test_claude_agents_resolve_prompt(self) -> None:
        for path in sorted((ROOT / ".claude" / "agents").glob("*.md")):
            text = path.read_text(encoding="utf-8")
            fields = skill_frontmatter(text)
            self.assertEqual(path.stem, fields["name"])
            self.assertTrue(fields["description"])
            match = re.search(r"\$\{CLAUDE_PLUGIN_ROOT\}/(skills/[^`]+AGENT\.md)`", text)
            self.assertIsNotNone(match, path.name)
            self.assertTrue((ROOT / match.group(1)).is_file(), match.group(1))

    @unittest.skipUnless(shutil.which("kiro-cli"), "kiro-cli not installed")
    def test_kiro_cli_accepts_every_agent(self) -> None:
        for path in sorted((ROOT / ".kiro" / "agents").glob("*.json")):
            result = subprocess.run(
                ["kiro-cli", "agent", "validate", "--path", str(path)],
                capture_output=True, text=True, timeout=60,
            )
            self.assertNotIn("invalid", result.stderr + result.stdout, path.name)

    @unittest.skipUnless(shutil.which("claude"), "claude CLI not installed")
    def test_claude_cli_validates_the_plugin(self) -> None:
        result = subprocess.run(
            ["claude", "plugin", "validate", str(ROOT)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)


class DocumentationTests(unittest.TestCase):
    """Docs describe the script-free, three-harness package."""

    def test_single_skill_is_the_documented_default(self) -> None:
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(f"The **recommended default** is the `{SKILL_NAME}` skill", readme)
        self.assertIn("No build step is needed", readme)

    def test_current_guidance_avoids_legacy_labels(self) -> None:
        for relative_path in GUIDANCE_FILES:
            text = (ROOT / relative_path).read_text(encoding="utf-8")
            for legacy_text in LEGACY_GUIDANCE:
                self.assertNotIn(legacy_text, text, f"found in {relative_path}")

    def test_repository_local_links_resolve(self) -> None:
        for source in repository_markdown():
            text = source.read_text(encoding="utf-8")
            for destination in local_links(text):
                target_text, separator, fragment = destination.partition("#")
                target = (source.parent / target_text).resolve() if target_text else source
                self.assertTrue(target.exists(), f"{source.relative_to(ROOT)} links to missing target {destination}")
                if separator and target.is_file() and target.suffix.lower() == ".md":
                    self.assertIn(
                        fragment,
                        markdown_anchors(target.read_text(encoding="utf-8")),
                        f"{source.relative_to(ROOT)} links to missing anchor {destination}",
                    )


if __name__ == "__main__":
    unittest.main()
