"""py_dead_params finds a never-passed default, a constant argument and a dead config fallback, not look-alikes."""
from __future__ import annotations

import json

from audit_common import CDK_DIR
from py_dead_params import bundled_json, config_findings, load_corpus, main, param_findings

from conftest import TreeMaker

LIB = '''
def recent(rows, limit=5):
    return rows[:limit]

def child(project, count_attribute):
    return project, count_attribute

def tuned(rows, limit=5):          # a test varies it: still a knob
    return rows[:limit]

def passed_around(rows, limit=5):  # escapes as a value: calls by name are not all its calls
    return rows[:limit]

def splatted(rows, limit=5):       # a call with **kwargs could bind anything
    return rows[:limit]

class Box:
    def count(self, amount=1):     # bound by position like list.count(x): judged on its own calls only
        return amount
'''
USE = '''
from lib import Box, child, passed_around, recent, splatted, tuned

def run(rows, opts):
    callbacks = [passed_around]
    Box().count(2)
    return (recent(rows), recent(rows), child('p', 'document_count'), child('q', 'document_count'),
            tuned(rows), tuned(rows), splatted(rows, **opts), callbacks)
'''
TEST = '''
from lib import tuned

def test_tuned():
    assert tuned([1, 2], limit=1) == [1]
'''
PROMPTS = '''
import json

AVATAR = 'avatar.json'

def load_prompt_file(name):
    return json.loads(open(name).read())

def get_avatar_config():
    return load_prompt_file(AVATAR)

def avatar_prompt():
    config = get_avatar_config()
    image = config.get('image', {})
    return (config.get('template', 'Headshot of a {job}'),     # dead: the JSON has it
            config.get('style', 'plain'),                     # live: the JSON omits it
            image.get('model', 'model-a'),                    # dead, one level down
            get_avatar_config().get('size', 512))             # dead, straight off the loader
'''
CONFIG = {'template': 'Headshot of a {job}', 'size': 512, 'image': {'model': 'model-a'}}


def test_planted_parameters_are_found_and_look_alikes_are_not(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/shared/lib.py': LIB, 'lambda/api/use.py': USE, 'lambda/shared/test/test_lib.py': TEST})
    found, _ = param_findings(load_corpus(root))
    assert sorted((f.kind, f.key) for f in found) == [
        ('constant-arg', 'lambda/shared/lib.py::child(count_attribute)'),
        ('dead-default', 'lambda/shared/lib.py::recent(limit)'),
    ]


def test_a_fallback_for_a_key_the_bundled_json_has_is_dead(make_tree: TreeMaker) -> None:
    root = make_tree({'lambda/shared/prompts.py': PROMPTS, 'lambda/api/prompts/avatar.json': json.dumps(CONFIG)})
    found = config_findings(load_corpus(root), bundled_json(root))
    assert sorted(f.key.rsplit(':', 1)[-1] for f in found) == ['image', 'image.model', 'size', 'template']


def test_the_real_tree_is_clean() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
