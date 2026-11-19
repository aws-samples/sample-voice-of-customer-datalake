# Sources

Non-obvious claims verified against upstream docs. Checked 2026-10-28.

- `pyright` strict mode is a config setting (`typeCheckingMode: "strict"` in
  `pyrightconfig.json` or `[tool.pyright]` in pyproject.toml), not a CLI flag.
  `pyright --help` lists no `--strict` option; the README's "Comments" section
  and config docs confirm `typeCheckingMode` as the only switch.
  https://github.com/microsoft/pyright/blob/main/docs/configuration.md
- Current PyPI versions checked at review time: `uv` 0.13.6, `ruff` 0.17.3,
  `pyright` 1.1.414, `boto3` 1.43.120, `pydantic` 2.14.1. Confirms `uv`,
  `ruff`, and `pyright` are the active tools to recommend (none superseded).
  https://pypi.org/pypi/uv/json, https://pypi.org/pypi/ruff/json,
  https://pypi.org/pypi/pyright/json
