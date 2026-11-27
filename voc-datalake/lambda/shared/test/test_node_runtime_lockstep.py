"""Guard test for the Node.js major, mirrored in the workflows and the CDK (7.104.00 review, Q3).

The Node twin of `test_python_runtime_lockstep.py`. Every `.github/workflows/*.yml` that sets up Node names its major
in `actions/setup-node`'s `node-version`; the CDK stacks under `lib/` declare `lambda.Runtime.NODEJS_*_X` for the
three Node Lambdas (`voc-chat-stream`, `voc-plan-step`, the CDN signing-key custom resource), which decides the Node
they execute on. Nothing tied the two together: 7.104.00 moved the Lambdas to Node 26 while CI stayed on 24, so the
stream package's tests and the bundles' build ran on a Node no Lambda runs.

One exception, by AWS's limit and named here so it is never read as drift: the voice relay
(`lib/stacks/voice-relay.ts`) is not a Lambda. It runs on Amazon Bedrock AgentCore Runtime's direct code deployment,
whose newest Node is `NODE_22`, and is bundled on `Runtime.NODEJS_22_X`'s image to match. Its file is left out of
the comparison, and `test_the_voice_relay_is_the_one_exception` holds it to `NODE_22` so that the exclusion is looked
at again when AgentCore takes a newer Node.

A full checkout is required, as for every lockstep test ("A full checkout is required" in `shared/test/repo_paths.py`).
"""
import re

from shared.test.repo_paths import repo_root

_CDK_DIR = repo_root() / 'lib'
_WORKFLOWS_DIR = repo_root().parent / '.github' / 'workflows'
# AgentCore Runtime's direct code deployment takes NODE_22 at the newest: the relay is not a Lambda (docstring).
_AGENTCORE_RELAY = _CDK_DIR / 'stacks' / 'voice-relay.ts'
_AGENTCORE_NODE = '22'


def _lambda_node_majors() -> set[str]:
    """Every distinct major named by a `Runtime.NODEJS_<major>_X` in `lib/`'s stacks, tests and the relay left out."""
    found: set[str] = set()
    for source in _CDK_DIR.rglob('*.ts'):
        if source == _AGENTCORE_RELAY or source.name.endswith('.test.ts'):
            continue
        found.update(re.findall(r'Runtime\.NODEJS_(\d+)_X\b', source.read_text(encoding='utf-8')))
    return found


def _workflow_node_versions() -> dict[str, list[str]]:
    """Each workflow's `node-version` values, by file name; a workflow that sets up no Node is absent."""
    versions: dict[str, list[str]] = {}
    for workflow in sorted(_WORKFLOWS_DIR.glob('*.yml')):
        text = workflow.read_text(encoding='utf-8')
        named = re.findall(r'^\s*node-version:\s*[\'"]?([^\'"\s#]+)', text, re.MULTILINE)
        steps = len(re.findall(r'uses:\s*actions/setup-node@', text))
        assert len(named) == steps, f'{workflow.name}: {steps} setup-node steps, {len(named)} node-version lines'
        if named:
            versions[workflow.name] = named
    return versions


class TestNodeRuntimeMirror:
    """Both sides readable, the stacks agreeing among themselves, and CI on their major."""

    def test_the_lambda_runtime_is_findable(self):
        """The positive control for the CDK side: a refactor the regex cannot see would compare against nothing."""
        assert _lambda_node_majors(), 'parsed no Runtime.NODEJS_*_X from lib/ (the relay left out): parser drift?'

    def test_the_stacks_agree_among_themselves(self):
        majors = _lambda_node_majors()
        assert len(majors) == 1, f'lib/ declares more than one Lambda Node runtime: {sorted(majors)}'

    def test_every_workflow_tests_the_major_the_lambdas_run(self):
        """Every setup-node step names exactly the Lambdas' major: no other line, no range, no `lts/*`."""
        versions = _workflow_node_versions()
        assert len(versions) >= 5, f'found {len(versions)} workflows that set up Node under {_WORKFLOWS_DIR}: drift?'
        expected = _lambda_node_majors()
        off = {name: named for name, named in versions.items() if set(named) != expected}
        assert not off, (f'the Node Lambdas run {sorted(expected)} but these workflows set up {off}: bump them in the '
                         'same change as Runtime.NODEJS_*_X')

    def test_the_voice_relay_is_the_one_exception(self):
        """The relay runs on AgentCore's NODE_22 and bundles on NODEJS_22_X's image; when AgentCore takes a newer
        Node, move it and drop the exclusion above."""
        source = _AGENTCORE_RELAY.read_text(encoding='utf-8')
        assert (re.findall(r"runtime:\s*'NODE_(\d+)'", source), re.findall(r'Runtime\.NODEJS_(\d+)_X\b', source)) == (
            [_AGENTCORE_NODE], [_AGENTCORE_NODE])

