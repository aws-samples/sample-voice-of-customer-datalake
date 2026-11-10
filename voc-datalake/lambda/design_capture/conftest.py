"""Fixtures of the design-capture tests (never bundled: the asset prune drops every conftest.py).

``jsdom_env`` locates what the DOM tests (``test_*_dom.py``) need to run the page collectors in a real DOM:
a ``node`` binary (``$NODE_BINARY``, else the one on ``PATH``) and jsdom from the frontend's own
``node_modules`` (``npm ci`` in ``voc-datalake/frontend``; CI installs it, Node 22). Either missing → the test
is SKIPPED with the reason, never failed: the collectors are also covered by the Python-side tests.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

FRONTEND = Path(__file__).resolve().parents[2] / 'frontend'

#: Reads ``{html, expression, url, element}`` as JSON on stdin, evaluates ``expression`` in the page and prints its
#: answer as JSON. jsdom has no layout, so every ``element`` (an interface name: ``HTMLImageElement``,
#: ``SVGElement``) gets its box from ``data-box="width height top"``.
RUNNER = r"""
const { JSDOM } = require('jsdom');
const { html, expression, url, element } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const { window } = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
window[element].prototype.getBoundingClientRect = function () {
  const [width, height, top] = (this.getAttribute('data-box') || '0 0 0').split(' ').map(Number);
  return { x: 0, y: top, top, left: 0, width, height, right: width, bottom: top + height };
};
const raw = window.eval(expression);
process.stdout.write(typeof raw === 'string' ? raw : JSON.stringify(raw));
"""


@dataclass(frozen=True)
class JsdomEnv:
    """``node`` (an absolute path) and the directory whose ``node_modules`` holds jsdom (the cwd to run in)."""
    node: str
    cwd: Path

    def evaluate(self, html: str, expression: str, url: str, element: str) -> object:
        """``expression``'s answer in ``html`` loaded at ``url`` (decoded JSON); boxes on ``element`` (see RUNNER)."""
        payload = json.dumps({'html': html, 'expression': expression, 'url': url, 'element': element})
        done = subprocess.run([self.node, '-e', RUNNER], input=payload, capture_output=True, text=True,
                              cwd=self.cwd, timeout=60, check=False)
        assert done.returncode == 0, done.stderr[-2000:]
        return json.loads(done.stdout)


@pytest.fixture(scope='session')
def jsdom_env() -> JsdomEnv:
    node = os.environ.get('NODE_BINARY') or shutil.which('node')
    if not node or not Path(node).is_file():
        pytest.skip('node is not installed (set NODE_BINARY or put node on PATH) to run the collector in a DOM')
    if not (FRONTEND / 'node_modules' / 'jsdom' / 'package.json').is_file():
        pytest.skip('jsdom is missing: run `npm ci` in voc-datalake/frontend to run the collector in a DOM')
    return JsdomEnv(str(Path(node).resolve()), FRONTEND)
