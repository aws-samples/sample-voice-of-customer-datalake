"""The Kiro adapter (7.53.00): the agent is Kiro CLI over ACP (``kiro-cli acp --agent-engine=v3``), its tools the
harness's own, over MCP.

The harness starts kiro-cli as its child (so it runs as the agent user, ``unit``, in the harness's own user and
network namespace: the 7.50.03 walls hold for it as for the harness) and is its only ACP client (``acp.py``: stdio,
no listener). What the agent can do is what the platform's tool server (``tool_server.py``, the CLI adapter's, started
by kiro-cli from the agent's config) offers: exactly the tools of the session's ``ToolBox``, the role's skill's tool
policy within its role, served from the harness's own registry, so a tool a later release adds reaches Kiro with no
edit here. Kiro's own tools are never offered:

- **The agent's config** is written per session (``session_agent``) into an isolated ``HOME`` of its own
  (``<agent home>/.voc/kiro/home``, wiped at each start: no developer's, image's or repository's Kiro agents, settings,
  steering or skills load), from the role's compiled config (``templates/orchestration/kiro-agents/<role>.json``, in the
  images at ``/opt/voc/orchestration/kiro-agents``): its name and description, and its one tool server, checked to be
  the harness's. The prompt is the session's own (the platform's rules with this session's fence, then the skill the
  board served); ``tools`` is ``["@voc"]`` only; ``allowedTools`` and the ``permissions.rules`` allow exactly
  ``voc/<tool>`` for the session's tools. kiro-cli starts in an empty directory of that home, never the checkout (a
  ``.kiro/agents`` there would be loaded as the workspace's), and is told ``mcpServers: []`` in ACP.
- **Permission requests** (``session/request_permission``: anything not pre-allowed) are answered by the harness's
  policy (``permission_answer``), fail closed: ``allow_once`` only for a ``@voc/<tool>`` the session's ToolBox offers
  (which the tool server enforces again), ``reject_once`` for everything else, never an ``allow_always``; a request it
  cannot read is answered ``cancelled``. Each decision is in the transcript (``permission``).
- **The key.** ``KIRO_API_KEY`` is read just in time from SSM (``ssm_key``: the deployment's
  ``/[<prefix>-]voc/engineering-kiro/api-key``, which only the roles that run on Kiro may read), with the agent's own
  role session, and handed to kiro-cli's environment only: never an argument, a file, a log line, the transcript, the
  status or the tool server (whose config blanks it). Nothing here keeps it after the child started.

The ACP mapping (docs/autonomous-engineering.md, "The Kiro harness (7.53.00)"):

- the brief = ``session/new`` then ``session/set_config_option {configId: mode, value: <role>}`` (refused unless Kiro
  says the mode is the role: its prompt and rules would not apply), then (7.58.00) the session's model, the one its
  launch chose or else Kiro's name for its skill's (``session/set_config_option {configId: model, value: <Kiro model
  id>}``: unless Kiro answers that it is the model, ``auto`` taking any, the step ends for a person, saying why, and no
  other model runs; a model with no Kiro name ends it before kiro-cli starts), then ``session/prompt`` with
  ``converse_loop.opening``;
- steering (7.51's ``relay_steering`` and the run's direction, from the inbox) = a ``session/prompt`` sent mid-turn, in
  the session's ``<<<STEERING …>>>`` fence below the platform rules: Kiro cancels the running turn (``cancelled``) and
  goes on with it, keeping its context; for the run coordinator a wake for its tool server too (7.54.00), so a
  ``wait_for_agents`` under way ends and the next tool call is not held behind it;
- a pause (a person's Stop, a Shut down, a save-and-stop) = ``session/cancel``, then the session's checkpoint, then exit
  75; a crash saves the checkpoint too;
- progress = ``session/update``: ``agent_message_chunk`` and ``agent_thought_chunk`` (coalesced), Kiro's own tool calls
  and refused ones as ``tool_call``/``tool_result`` with the ACP ``call_id``, ``tool_kind`` and ``status`` (the
  platform's tools are recorded by the tool server, as for the CLI), ``plan`` and ``usage_update``;
- spend (7.58.00) = each turn's credits as kiro-cli reports them (``turn_credits``): on the v3 engine (the harness's,
  ``KIRO_ARGV``) a ``session_info_update`` of kind ``turn_completion`` (``promptTurnSummaries``, ``elapsedTime``,
  ``turnId``), on the v2 engine the ``_kiro.dev/metadata`` that carries ``meteringUsage`` and ``turnDurationMs``; the
  entries in ``credit`` are summed, counted once per turn (a v3 turn by its id), recorded (``kiro_credits``: the
  credits, the turn's milliseconds, the model) and reported on the session's status as the model ``kiro:<model>``'s
  ``micro_credits``, which the runtime ledgers at the deployment's price per credit
  (``-c engineeringKiroCreditPrice``), so the run's cost cap, its flow's budget and the hard cap count them; another
  unit is recorded, never counted, and v3's running total (``session_usage``) is recorded beside them
  (``kiro_session_credits``), never counted;
- resume = ``session/load {sessionId}`` in the new process, from the Kiro session's state saved with each checkpoint
  (``$HOME/.kiro/sessions``, packed under the agent's own ``_kiro/attempt-<n>/`` keys) or with a child run's seed;
  without one, or when the load is refused, the 7.51 path: a fresh session opened with the checkpoint's notes, or the
  seed's history.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import tarfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, Decimal
from typing import Any, Final

from engineering.runtime.checkpoints import artifact_prefix
from engineering.runtime.harness.acp import AcpClient, AcpError, AcpTimeout, Notification
from engineering.runtime.harness.cli import PATH, TOOL_SERVER, crash_checkpoint, sync_notes
from engineering.runtime.harness.converse_loop import nudge, opening, system_prompt
from engineering.runtime.harness.effort import CLAUDE_EFFORT
from engineering.runtime.harness.interface import AgentSession, Ending
from engineering.runtime.harness.kiro_pin import KEY_PARAMETER_RE, KIRO_CHOICES, kiro_model
from engineering.runtime.harness.seed import seed_prefix
from engineering.runtime.harness.tool_server import SERVER_NAME, SessionFiles
from engineering.runtime.harness.tools import DIRECTION, MAX_RUN_SECONDS, STEER
from engineering.runtime.harness.transcript import tool_kind
from engineering.runtime.harness.waiting import TOOL
from engineering.runtime.interface import MICRO_PER_CREDIT

KIRO_BINARY: Final = '/usr/local/bin/kiro-cli'
#: The ACP config option of a session's effort (kiro-cli 3.4.0: ``low`` to ``max``, as Claude's levels).
EFFORT_OPTION: Final = 'effortLevel'
#: Each Claude model's effort by its Kiro name (``effort.CLAUDE_EFFORT``'s models by ``kiro_pin.kiro_model``): a session
#: runs at the effort of the model it asked for (``_KiroRun.choose_effort``).
KIRO_EFFORT: Final = {name: level for model, level in CLAUDE_EFFORT.items() if (name := kiro_model(model))}
#: How it is started: ACP on stdio, the v3 engine (whose agents are chosen per session, ``session/set_config_option``).
KIRO_ARGV: Final = ('acp', '--agent-engine=v3')
#: The compiled role configs in the images (templates/orchestration/kiro-agents/, copied by every Dockerfile).
KIRO_AGENTS_DIR: Final = '/opt/voc/orchestration/kiro-agents'
#: The variable kiro-cli reads its API key from (headless, no login: checked with kiro-cli 3.3.0 and 3.4.0).
KEY_ENV: Final = 'KIRO_API_KEY'
#: The isolated Kiro home and its working directory, under the agent's home (the same path in every session of the
#: agent, so a restored session's workspace is the one it was saved in: Kiro keys its sessions by that directory).
KIRO_ROOT: Final = os.path.join('.voc', 'kiro')
HOME_NAME: Final = 'home'
WORK_NAME: Final = 'work'
#: Where kiro-cli keeps its ACP sessions in its home (``<workspace hash>/<session id>/{session.json,messages.jsonl}``):
#: what a checkpoint saves and a continuation restores before ``session/load``.
SESSIONS_DIR: Final = os.path.join('.kiro', 'sessions')
#: Kiro's tool call timeout for the platform's tool server: a repository command may run its hour.
MCP_TIMEOUT_MS: Final = (MAX_RUN_SECONDS + 10 * 60) * 1000

INITIALIZE_SECONDS: Final = 120.0
SESSION_SECONDS: Final = 120.0
LOAD_SECONDS: Final = 300.0
MODE_SECONDS: Final = 60.0
#: How long a cancelled turn has to answer ``cancelled`` before kiro-cli is ended anyway.
CANCEL_SECONDS: Final = 30.0
#: A turn with no frame from kiro-cli for this long is a crash (a platform tool may run for its hour, quietly).
STALL_SECONDS: Final = MAX_RUN_SECONDS + 15 * 60
#: After the model's ``finish``, how long its turn may go on before it is cancelled and the session ends done.
FINISH_GRACE_SECONDS: Final = 120.0
#: Turns that stopped at Kiro's own token or request limit, continued at most this often in one session.
MAX_CONTINUES: Final = 20
POLL_SECONDS: Final = 5.0
#: How long kiro-cli has to exit once its stdin closes, before its whole process group is killed.
EXIT_SECONDS: Final = 10.0
#: The saved session state's bounds: the packed archive, the files in it, one file, all of them unpacked.
MAX_STATE_BYTES: Final = 32 * 1024 * 1024
MAX_STATE_FILES: Final = 2_000
MAX_STATE_FILE: Final = 64 * 1024 * 1024
MAX_STATE_UNPACKED: Final = 256 * 1024 * 1024
#: A Kiro session id (``sess_<uuid>``): plain characters only.
SESSION_ID_RE: Final = re.compile(r'[A-Za-z0-9_.:-]{1,128}\Z')
#: What the first prompt of a loaded session says (its conversation so far is Kiro's own).
CONTINUE_LOADED: Final = ('You are continuing this task in a new session: your conversation so far is above, as you '
                          'left it. Go on with your tools, and call finish when the task is done.')
CONTINUE_LIMIT: Final = 'Continue with your task where you stopped.'
#: The environment kiro-cli gets from the harness's own (its proxy: the agent's, the session's one way out).
PROXY_VARIABLES: Final = ('HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy')


class KiroNotOffered(RuntimeError):
    """kiro-cli missing, not the pinned version, its key not readable, or no compiled config for the role."""


class ModelRefused(RuntimeError):
    """Kiro cannot run the session's model (7.58.00): it refused it, does not offer it on the account, answered another,
    or the model has no Kiro name. Never a crash (a continuation would meet it again), and never another model (the
    owner's rule: nobody pays for a model they did not pick): the step ends for a person, in these words."""


class StateRefused(ValueError):
    """A Kiro session state that is not saved or not restored (too big, an entry off its shape)."""


# -- the key ------------------------------------------------------------------------------------------------------


def ssm_key(parameter: str, region: str, client: Any = None) -> Callable[[], str]:
    """The key's reader: ``ssm:GetParameter`` (decrypted) on exactly ``parameter`` with the agent's own role session
    (the only grant its role has on SSM: engineering-runtime.ts). A failure names the error's code, never a value."""
    if not KEY_PARAMETER_RE.fullmatch(parameter):
        raise KiroNotOffered(f'{parameter!r} is not the deployment\'s Kiro key parameter')

    def read() -> str:
        ssm = client
        if ssm is None:
            import boto3
            ssm = boto3.client('ssm', region_name=region)
        try:
            value = ssm.get_parameter(Name=parameter, WithDecryption=True)['Parameter']['Value']
        except Exception as error:  # noqa: BLE001 - only its kind and code are said, never what it held
            code = getattr(error, 'response', {}).get('Error', {}).get('Code', '') if hasattr(error, 'response') else ''
            raise KiroNotOffered(f'the Kiro API key could not be read ({type(error).__name__} {code})'.strip()) from None
        key = str(value).strip()
        if not key or any(character.isspace() for character in key):
            raise KiroNotOffered('the Kiro API key parameter holds no key')
        return key

    return read


def kiro_env(home: str, harness_env: Mapping[str, str], key: str) -> dict[str, str]:
    """kiro-cli's whole environment: its own home (and its logs and temporary files in it), the agent's proxy, the
    key; nothing else inherited (no AWS variable: Kiro needs none)."""
    return {'PATH': PATH, 'HOME': home, 'LANG': 'C.UTF-8', 'TMPDIR': os.path.join(home, 'tmp'),
            'XDG_RUNTIME_DIR': os.path.join(home, 'run'),
            **{name: harness_env[name] for name in PROXY_VARIABLES if name in harness_env}, KEY_ENV: key}


# -- the agent's config -------------------------------------------------------------------------------------------


def compiled_config(role: str, directory: str = KIRO_AGENTS_DIR) -> dict[str, Any]:
    """The role's compiled config (``orchestration/compile.py`` ``kiro_agent``), checked: its one tool server is the
    harness's. Refused when the image ships none for the role, or one that names another server or a Kiro tool."""
    path = os.path.join(directory, f'{role}.json')
    try:
        with open(path) as stream:
            config = json.load(stream)
    except (OSError, ValueError) as error:
        raise KiroNotOffered(f'no compiled Kiro config for the {role} ({type(error).__name__})') from None
    servers = config.get('mcpServers') if isinstance(config, dict) else None
    server = servers.get(SERVER_NAME) if isinstance(servers, dict) else None
    if (not isinstance(servers, dict) or not isinstance(server, dict) or set(servers) != {SERVER_NAME}
            or server.get('command') != TOOL_SERVER[0] or server.get('args') != list(TOOL_SERVER[1:])):
        raise KiroNotOffered(f'the compiled Kiro config of the {role} names a tool server other than the harness\'s')
    if config.get('tools') != [f'@{SERVER_NAME}']:
        raise KiroNotOffered(f'the compiled Kiro config of the {role} offers Kiro tools beside the platform\'s')
    return config


def session_agent(session: AgentSession, base: Mapping[str, Any], server_env: Mapping[str, str],
                  chosen: str = '') -> dict[str, Any]:
    """The agent's config for this session: the role's compiled one, with the session's prompt (its fence and the skill
    the board served) and exactly the session's tools (``ToolBox.specs``), each allowed without asking; nothing of
    Kiro's own. Its ``model`` is the Kiro model the launch chose (7.58.00, ``chosen``: ``--kiro-model``), else Kiro's
    name for the session's model (``kiro_pin.kiro_model``), so Kiro runs the model the skill names, never its own
    default (``auto``); none for a model Kiro has no name for. A key named ``KIRO_API_KEY`` in the server's environment
    is blanked, so the tool server never holds the key kiro-cli has."""
    context, names = session.context, sorted(spec.name for spec in session.tools.specs)
    model = chosen or kiro_model(context.model)
    return {
        'name': context.role,
        'description': str(base.get('description', ''))[:500],
        **({'model': model} if model else {}),
        'prompt': system_prompt(context, session.tools.skill),
        'tools': [f'@{SERVER_NAME}'],
        'allowedTools': [f'@{SERVER_NAME}/{name}' for name in names],
        'mcpServers': {SERVER_NAME: {'command': TOOL_SERVER[0], 'args': list(TOOL_SERVER[1:]),
                                     'env': {**server_env, KEY_ENV: ''}, 'timeout': MCP_TIMEOUT_MS}},
        'resources': [],
        'permissions': {'rules': [{'capability': 'mcp', 'match': [f'{SERVER_NAME}/{name}' for name in names],
                                   'effect': 'allow'}]},
    }


# -- the permission policy ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    answer: dict[str, Any]
    #: ``allowed`` | ``refused`` | ``cancelled`` (an option to answer with was missing).
    decision: str
    title: str
    call_id: str
    reason: str


def platform_tool(title: str) -> str | None:
    """The platform tool a Kiro tool call names (its ``title`` is ``@voc/<tool>``), None for any other."""
    prefix = f'@{SERVER_NAME}/'
    name = title[len(prefix):] if title.startswith(prefix) else ''
    return name if re.fullmatch(r'[a-z][a-z0-9_]{0,63}', name) else None


def permission_answer(params: Mapping[str, Any], allowed: frozenset[str]) -> Decision:
    """The harness's answer to ``session/request_permission``, fail closed: ``allow_once`` only for a platform tool the
    session offers, ``reject_once`` for every other call (a Kiro tool, another server's, a tool the role may not have),
    never ``allow_always``; ``cancelled`` when the option to answer with is not among those offered."""
    raw = params.get('toolCall')
    call: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
    title, call_id = str(call.get('title', ''))[:200], str(call.get('toolCallId', ''))[:128]
    name = platform_tool(title)
    wanted = 'allow_once' if name is not None and name in allowed else 'reject_once'
    reason = ('a platform tool of this agent' if wanted == 'allow_once'
              else 'not a tool of this agent: only its platform tools run')
    options = params.get('options')
    option = next((item for item in options if isinstance(item, Mapping) and item.get('kind') == wanted
                   and isinstance(item.get('optionId'), str)), None) if isinstance(options, list) else None
    if option is None:
        return Decision({'outcome': {'outcome': 'cancelled'}}, 'cancelled', title, call_id, f'no {wanted} option')
    return Decision({'outcome': {'outcome': 'selected', 'optionId': option['optionId']}},
                    'allowed' if wanted == 'allow_once' else 'refused', title, call_id, reason)


# -- the saved session state --------------------------------------------------------------------------------------


def pack_sessions(root: str) -> bytes:
    """``root`` (a Kiro home's ``.kiro/sessions``) as a gzipped tar of its plain files: no link, no special file, each
    JSON Lines file cut at its last newline (kiro-cli may be appending to it), every bound held."""
    buffer = io.BytesIO()
    count, total = 0, 0
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for directory, folders, names in os.walk(root, followlinks=False):
            folders[:] = sorted(folder for folder in folders if not os.path.islink(os.path.join(directory, folder)))
            for name in sorted(names):
                path = os.path.join(directory, name)
                if not stat.S_ISREG(os.lstat(path).st_mode):
                    continue
                with open(path, 'rb') as stream:
                    data = stream.read(MAX_STATE_FILE + 1)
                if len(data) > MAX_STATE_FILE:
                    raise StateRefused(f'a session file is over {MAX_STATE_FILE // (1024 * 1024)} MB')
                if name.endswith('.jsonl'):
                    data = data[:data.rfind(b'\n') + 1]
                count, total = count + 1, total + len(data)
                if count > MAX_STATE_FILES or total > MAX_STATE_UNPACKED:
                    raise StateRefused('the Kiro session state is over its bounds')
                info = tarfile.TarInfo(os.path.relpath(path, root).replace(os.sep, '/'))
                info.size, info.mode, info.mtime = len(data), 0o600, 0
                archive.addfile(info, io.BytesIO(data))
    body = buffer.getvalue()
    if len(body) > MAX_STATE_BYTES:
        raise StateRefused(f'the Kiro session state is over {MAX_STATE_BYTES // (1024 * 1024)} MB packed')
    return body


_ENTRY_RE: Final = re.compile(r'(?:[A-Za-z0-9_.:-]+/){0,4}[A-Za-z0-9_.:-]+\Z')


def unpack_sessions(body: bytes, root: str) -> int:
    """A packed state into ``root``: plain files only, each under it by a plain relative name (no ``..``, no absolute
    path, no link, at most four folders deep), every bound held; the files written."""
    if len(body) > MAX_STATE_BYTES:
        raise StateRefused('the saved Kiro session state is over its bound')
    written, total = 0, 0
    try:
        with tarfile.open(fileobj=io.BytesIO(body), mode='r:gz') as archive:
            for member in archive:
                written += 1
                if written > MAX_STATE_FILES:
                    raise StateRefused('the saved Kiro session state holds too many files')
                if not member.isfile() or not _ENTRY_RE.fullmatch(member.name) or '..' in member.name.split('/'):
                    raise StateRefused(f'the saved Kiro session state holds an entry off its shape: {member.name[:80]!r}')
                total += member.size
                if member.size > MAX_STATE_FILE or total > MAX_STATE_UNPACKED:
                    raise StateRefused('the saved Kiro session state is over its bounds unpacked')
                source = archive.extractfile(member)
                if source is None:
                    raise StateRefused('the saved Kiro session state could not be read')
                target = os.path.join(root, *member.name.split('/'))
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as stream:
                    shutil.copyfileobj(source, stream)
    except (tarfile.TarError, OSError, EOFError) as error:
        raise StateRefused(f'the saved Kiro session state could not be unpacked ({type(error).__name__})') from None
    return written


def _state_ref(raw: object) -> tuple[str, str] | None:
    """A checkpoint's or a seed's ``kiro`` entry: (session id, the state's key), None for none or one off its shape."""
    if not isinstance(raw, Mapping):
        return None
    session_id, key = raw.get('session_id'), raw.get('state')
    if isinstance(session_id, str) and SESSION_ID_RE.fullmatch(session_id) and isinstance(key, str) and key:
        return session_id, key
    return None


# -- the adapter --------------------------------------------------------------------------------------------------


@dataclass
class _Prompt:
    kind: str
    started: float
    #: The inbox messages it carried (steering): they reached the model once Kiro took the prompt.
    event_ids: list[str] = field(default_factory=list)


#: The coalesced chunks a session holds before it writes them as one event (a long answer is several events).
MAX_HELD_CHUNKS: Final = 16 * 1024


class KiroAcp:
    """``Adapter`` on kiro-cli over ACP, at ``version`` exactly. ``key`` reads the API key (``ssm_key``);
    ``environment`` is the harness's own (its proxy), ``tool_env`` the tool server's (as the CLI adapter's); ``model``
    (7.58.00, ``--kiro-model``) the Kiro model the launch chose ('' for none: Kiro's name for the skill's model)."""

    def __init__(self, *, binary: str, version: str, agent_home: str, environment: Mapping[str, str],
                 tool_env: Mapping[str, str], key: Callable[[], str], model: str = '',
                 configs_dir: str = KIRO_AGENTS_DIR,
                 run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
                 popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
                 killpg: Callable[[int, int], None] = os.killpg,
                 clock: Callable[[], float] = time.monotonic, poll_seconds: float = POLL_SECONDS,
                 timeouts: Mapping[str, float] | None = None) -> None:
        self.binary = binary
        self.version = version
        self.root = os.path.join(agent_home, KIRO_ROOT)
        self.environment = dict(environment)
        self.tool_env = dict(tool_env)
        self.key = key
        self.model = model
        self.configs = configs_dir
        self.run_command = run
        self.popen = popen
        self.killpg = killpg
        self.clock = clock
        self.poll = poll_seconds
        self.timeouts = {'initialize': INITIALIZE_SECONDS, 'session': SESSION_SECONDS, 'load': LOAD_SECONDS,
                         'mode': MODE_SECONDS, 'cancel': CANCEL_SECONDS, 'stall': STALL_SECONDS,
                         'finish': FINISH_GRACE_SECONDS, 'exit': EXIT_SECONDS, **(timeouts or {})}

    @property
    def home(self) -> str:
        return os.path.join(self.root, HOME_NAME)

    def check(self) -> None:
        """Refuse a kiro-cli that is missing or not the pinned version."""
        if not os.path.isabs(self.binary) or not os.access(self.binary, os.X_OK):
            raise KiroNotOffered(f'{self.binary} is not an installed kiro-cli (an absolute path is needed)')
        shown = self.run_command([self.binary, '--version'], capture_output=True, text=True, timeout=60,
                                 env={'PATH': PATH, 'HOME': self.root, 'LANG': 'C.UTF-8'}, check=False).stdout.strip()
        if not self.version or shown.split()[-1:] != [self.version]:
            raise KiroNotOffered(f'{self.binary} is {shown[:80]!r}, not the pinned kiro-cli {self.version}')

    def run(self, session: AgentSession) -> Ending:
        os.makedirs(self.root, mode=0o700, exist_ok=True)
        self.check()
        state = _KiroRun(self, session, compiled_config(session.context.role, self.configs))
        try:
            return state.run()
        except ModelRefused as refused:
            # (7.58.00) Not a crash: the step ends for a person, in these words, and no other model runs.
            state.end()
            session.stopped_for = str(refused)
            state.record('model_refused', model=self.model, reason=str(refused))
            session.context.status.at(str(refused))
            return 'done'
        except Exception:
            # Whatever failed (the protocol, a port, a tool's crash): kiro-cli is ended and the work saved first, the
            # tool server's last writes with it (Q6, 7.71.04).
            state.end()
            crash_checkpoint(session, state.files)
            raise
        finally:
            state.end()
            session.checkpoint_extra = None


class _KiroRun:
    """One session of the adapter: kiro-cli's process, its ACP client, the prompts in flight."""

    def __init__(self, adapter: KiroAcp, session: AgentSession, base: Mapping[str, Any]) -> None:
        self.adapter = adapter
        self.session = session
        self.base = base
        self.context = session.context
        self.allowed = frozenset(spec.name for spec in session.tools.specs)
        self.files = SessionFiles(os.path.join(adapter.root, 'session'))
        self.home = adapter.home
        self.work = os.path.join(self.home, WORK_NAME)
        self.process: subprocess.Popen[str] | None = None
        self.client: AcpClient | None = None
        self.session_id = ''
        self.prompts: dict[int, _Prompt] = {}
        self.current: int | None = None
        self.turns = 0
        self.nudged = False
        self.continues = 0
        self.finished_at: float | None = None
        self.seen: dict[str, Any] | None = None
        #: The inbox batches left for the tool server (as the CLI adapter's): file name -> their event ids.
        self.posted: dict[str, list[str]] = {}
        #: The ACP chunks read since the last other update, coalesced: their kind and text.
        self.held_kind = ''
        self.held: list[str] = []
        #: Kiro's own tool calls (not the platform's, which the tool server records): call id -> tool name.
        self.kiro_calls: dict[str, str] = {}
        self.replaying = False
        self.replayed = 0
        #: Whether the restored session is a child run's seed's (the parent's), not this agent's own checkpoint's.
        self.from_seed = False
        #: The model this session runs on Kiro (7.58.00, ``wanted_model``): '' for a session given none.
        self.wanted = ''
        #: (7.58.00) The model its credits are ledgered under (``kiro:<model>``, Kiro's answer once the session opened),
        #: the v3 turns already counted (by ``turnId``) and the millionths of a credit counted in this session.
        self.metered_model = ''
        self.metered_turns: set[str] = set()
        self.counted_micro = 0

    # -- the process ----------------------------------------------------------------------------------------------

    def prepare(self) -> tuple[str, str] | None:
        """A fresh Kiro home with the session's agent config, and the saved session restored into it when the
        checkpoint (or the child run's seed) names one: (its session id, why it was not restored) or None."""
        for folder in (self.home, self.files.directory):
            shutil.rmtree(folder, ignore_errors=True)
        for folder in (os.path.join(self.home, '.kiro', 'agents'), self.work, os.path.join(self.home, 'tmp'),
                       os.path.join(self.home, 'run'), self.files.directory):
            os.makedirs(folder, mode=0o700, exist_ok=True)
        server_env = {**self.adapter.tool_env, 'VOC_SESSION_FILES': self.files.directory}
        config = session_agent(self.session, self.base, server_env, self.wanted)
        with open(os.path.join(self.home, '.kiro', 'agents', f'{self.context.role}.json'), 'w') as stream:
            json.dump(config, stream)
        return self.restore()

    def restore(self) -> tuple[str, str] | None:
        """The saved Kiro session this session takes over (a continuation's checkpoint's, else a child run's seed's),
        unpacked into the home: (its id, '') when restored, (its id, why not) when it could not be, None for none."""
        restored = self.session.restored
        position = restored.get('position') if isinstance(restored, Mapping) else None
        own = _state_ref(position.get('kiro')) if isinstance(position, Mapping) else None
        seeded = _state_ref(self.session.seed.get('kiro')) if self.session.seed is not None and own is None else None
        found = own or seeded
        self.from_seed = own is None and seeded is not None
        if found is None:
            return None
        session_id, key = found
        under = self.kiro_prefix() if own is not None else seed_prefix(self.context.run_id)
        if not key.startswith(under) or '..' in key.split('/'):
            return session_id, 'its state is not under this agent\'s own keys'
        target = os.path.join(self.home, SESSIONS_DIR)
        try:
            unpack_sessions(self.context.store.get(key, MAX_STATE_BYTES), target)
        except StateRefused as refused:
            shutil.rmtree(target, ignore_errors=True)
            return session_id, str(refused)[:200]
        except Exception as error:  # noqa: BLE001 - a state that cannot be read: the session starts from the notes
            shutil.rmtree(target, ignore_errors=True)
            return session_id, f'its state could not be read ({type(error).__name__})'
        return session_id, ''

    def kiro_prefix(self) -> str:
        return artifact_prefix(self.context.run_id, self.context.agent_id, self.context.commit, self.context.attempt,
                               'kiro')

    def start(self) -> None:
        """kiro-cli started as the harness's child, in its own process group, in the home's empty working directory:
        the key in its environment only (the dict is cleared once the child has its copy)."""
        env = kiro_env(self.home, self.adapter.environment, self.adapter.key())
        try:
            self.process = self.adapter.popen([self.adapter.binary, *KIRO_ARGV], cwd=self.work, env=env,
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                              text=True, bufsize=1, start_new_session=True)
        finally:
            env.clear()
        if self.process.stdin is None or self.process.stdout is None:
            raise KiroNotOffered('kiro-cli was started without its pipes')
        self.client = AcpClient(self.process.stdin, self.process.stdout, on_request=self.on_request,
                                on_notification=self.on_notification, clock=self.adapter.clock)

    def end(self) -> None:
        """End kiro-cli: its stdin closed (it saves its session and exits), then its whole process group (its tool
        server included) once it has not exited in time. Never raises."""
        process, self.process = self.process, None
        if process is None:
            return
        self.flush_chunks()
        with contextlib.suppress(Exception):
            if process.stdin is not None:
                process.stdin.close()
        with contextlib.suppress(Exception):
            process.wait(timeout=self.adapter.timeouts['exit'])
        with contextlib.suppress(Exception):
            self.adapter.killpg(process.pid, signal.SIGKILL)
        with contextlib.suppress(Exception):
            process.wait(timeout=self.adapter.timeouts['exit'])

    def exit_code(self) -> int | None:
        return self.process.poll() if self.process is not None else None

    # -- the session's checkpoints ----------------------------------------------------------------------------------

    def save_state(self, seq: int) -> dict[str, Any]:
        """The checkpoint's ``kiro`` entry: the ACP session id and its state saved under the agent's own keys
        (``_kiro/attempt-<n>/<seq>-<nonce>.tgz``), or why it was not (the continuation then opens a fresh session from
        the checkpoint's notes)."""
        if not self.session_id:
            return {}
        entry: dict[str, Any] = {'session_id': self.session_id}
        try:
            body = pack_sessions(os.path.join(self.home, SESSIONS_DIR))
            key = f'{self.kiro_prefix()}{seq:06d}-{secrets.token_hex(4)}.tgz'
            self.context.store.put(key, body)
            entry['state'] = key
        except Exception as error:  # noqa: BLE001 - a state not saved costs the continuation its session/load only
            entry['state_refused'] = f'{type(error).__name__}: {error}'[:200]
        return {'kiro': entry}

    # -- what kiro-cli sends --------------------------------------------------------------------------------------

    def on_request(self, method: str, params: Mapping[str, Any]) -> Mapping[str, Any] | None:
        if method != 'session/request_permission':
            self.record('permission', method=method[:100], decision='refused',
                        reason='a method this client offers none of')
            return None   # (fs/*, terminal/*, anything else: method not found, never an allow)
        decision = permission_answer(params, self.allowed)
        self.record('permission', call_id=decision.call_id, title=decision.title, decision=decision.decision,
                    reason=decision.reason)
        if decision.decision != 'allowed':
            self.context.status.at(f'refused {decision.title or "a tool call"}: not a tool of this agent')
        return decision.answer

    def on_notification(self, notification: Notification) -> None:
        if notification.method == METADATA_METHOD:
            # (the v2 engine's own notification: a turn's credits, 7.58.00; never a loaded session's history)
            if notification.params.get('sessionId', self.session_id) == self.session_id and not self.replaying:
                self.metered(notification.method, notification.params)
            return
        if notification.method != 'session/update':
            return
        update = notification.params.get('update')
        if not isinstance(update, Mapping) or notification.params.get('sessionId') != self.session_id:
            return
        if self.replaying:
            self.replayed += 1   # (a loaded session's history: in the transcripts of the sessions that lived it)
            return
        kind = str(update.get('sessionUpdate', ''))
        if kind in ('agent_message_chunk', 'agent_thought_chunk'):
            content = update.get('content')
            text = content.get('text') if isinstance(content, Mapping) else None
            if isinstance(text, str):
                self.hold(kind, text)
            return
        self.flush_chunks()
        self.other_update(kind, update, notification)

    def other_update(self, kind: str, update: Mapping[str, Any], notification: Notification) -> None:
        """A ``session/update`` other than a chunk: Kiro's own tool calls, its plan, its usage, and (7.58.00) its
        ``session_info_update`` (a v3 turn's credits, or the session's total, among Kiro's other news)."""
        if kind == 'tool_call':
            self.tool_call(update)
        elif kind == 'tool_call_update':
            self.tool_update(update)
        elif kind == 'plan':
            self.record('plan', entries=update.get('entries', []))
        elif kind == 'usage_update':
            self.record('usage', **{str(name): value for name, value in update.items() if name != 'sessionUpdate'})
        elif kind == 'session_info_update':
            self.metered(notification.method, notification.params)

    def metered(self, method: str, params: Mapping[str, Any]) -> None:
        """(7.58.00) A turn's credits, as kiro-cli reported them (``turn_credits``): recorded (``kiro_credits``) and,
        once per turn (a v3 turn by its id: a second report of it is recorded, never counted), reported on the status
        as ``kiro:<model>``'s millionths of a credit, which the runtime ledgers at the deployment's price. v3's running
        total is recorded beside them, with what this session counted (``kiro_session_credits``), never counted."""
        found = turn_credits(method, params)
        if found is None:
            total = session_credits(params)
            if total is not None:
                self.record('kiro_session_credits', credits=float(total), counted_credits=self.counted_micro / MICRO_PER_CREDIT)
            return
        repeated = bool(found.turn_id) and found.turn_id in self.metered_turns
        if found.turn_id:
            self.metered_turns.add(found.turn_id)
        model = f'kiro:{self.metered_model or "unknown"}'
        counted = not repeated and found.micro_credits > 0
        self.record('kiro_credits', credits=found.micro_credits / MICRO_PER_CREDIT, micro_credits=found.micro_credits,
                    turn_ms=found.turn_ms, model=model, engine=found.engine, turn_id=found.turn_id or None,
                    counted=counted, **({'ignored': list(found.ignored)} if found.ignored else {}))
        if counted:
            self.counted_micro += found.micro_credits
            self.context.status.add_credits(model, found.micro_credits)

    def hold(self, kind: str, text: str) -> None:
        """One chunk of the agent's answer or thinking, coalesced with the ones before it of the same kind."""
        if kind != self.held_kind:
            self.flush_chunks()
            self.held_kind = kind
        self.held.append(text)
        if sum(len(part) for part in self.held) >= MAX_HELD_CHUNKS:
            self.flush_chunks()
            self.held_kind = kind

    def flush_chunks(self) -> None:
        if self.held_kind and self.held:
            self.record(self.held_kind, text=''.join(self.held))
        self.held_kind, self.held = '', []

    def tool_call(self, update: Mapping[str, Any]) -> None:
        title, call_id = str(update.get('title', ''))[:200], str(update.get('toolCallId', ''))[:128]
        name = platform_tool(title)
        if name is not None and name in self.allowed:
            return   # (the tool server records the platform's own calls, with their results)
        tool = name or f'kiro:{re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:60] or "tool"}'
        self.kiro_calls[call_id] = tool
        self.context.status.tool(tool)
        kind = update.get('kind')
        self.record('tool_call', tool=tool, input=update.get('rawInput'), call_id=call_id,
                    tool_kind=kind if isinstance(kind, str) and kind else tool_kind(tool),
                    status=str(update.get('status', 'pending')), origin='kiro')

    def tool_update(self, update: Mapping[str, Any]) -> None:
        call_id, status = str(update.get('toolCallId', ''))[:128], str(update.get('status', ''))
        tool = self.kiro_calls.get(call_id)
        if tool is None or status not in ('completed', 'failed'):
            return
        del self.kiro_calls[call_id]
        self.record('tool_result', tool=tool, text=_tool_text(update), error=status == 'failed', call_id=call_id,
                    status=status, origin='kiro')

    def record(self, kind: str, **fields: Any) -> None:
        if self.context.transcript is not None:
            self.context.transcript.record(kind, **fields)

    # -- the conversation -----------------------------------------------------------------------------------------

    @property
    def acp(self) -> AcpClient:
        if self.client is None:
            raise AcpError('kiro-cli is not started')
        return self.client

    def open(self, restored: tuple[str, str] | None) -> bool:
        """``initialize``, then the saved session loaded (True) or a new one, then the role's agent selected (refused
        unless Kiro says it is: on any other agent the role's prompt and rules would not apply), then the launch's
        model (``choose_model``)."""
        timeouts = self.adapter.timeouts
        capabilities = self.acp.initialize(timeouts['initialize']).get('agentCapabilities')
        loaded = False
        if restored is not None and not restored[1]:
            if isinstance(capabilities, Mapping) and capabilities.get('loadSession') is True:
                loaded, why = self.load(restored[0])
                restored = (restored[0], why)
            else:
                restored = (restored[0], 'kiro-cli does not load sessions')
        if restored is not None:
            self.record('acp_session', op='load', session_id=restored[0], loaded=loaded, replayed=self.replayed,
                        why_not=restored[1])
        if not loaded:
            answer = self.acp.wait(self.acp.request('session/new', {'cwd': self.work, 'mcpServers': []}),
                                   timeouts['session'])
            session_id = answer.get('sessionId')
            if not isinstance(session_id, str) or not SESSION_ID_RE.fullmatch(session_id):
                raise AcpError('kiro-cli answered session/new with no session id')
            self.session_id = session_id
            self.record('acp_session', op='new', session_id=session_id)
        mode = self.acp.wait(self.acp.request('session/set_config_option', {
            'sessionId': self.session_id, 'configId': 'mode', 'value': self.context.role}), timeouts['mode'])
        if _current(mode, 'mode') != self.context.role:
            raise AcpError(f'kiro-cli did not select the {self.context.role} agent')
        model, options = self.choose_model(self.wanted) if self.wanted else (_current(mode, 'model'), mode)
        level = self.choose_effort(self.wanted, options)
        # (its credits' ledger model: what Kiro answered, else what was asked; plain characters, as a ledger key takes)
        self.metered_model = _LEDGER_MODEL.sub('-', model or self.wanted)[:80]
        self.context.status.at(f'kiro session {"loaded" if loaded else "started"}' + (f' on {model}' if model else '')
                               + (f' at {level} effort' if level else ''))
        self.session.checkpoint_extra = self.save_state
        return loaded

    def wanted_model(self) -> str:
        """The model this session runs on Kiro (7.58.00): the one its launch chose (``--kiro-model``), else Kiro's name
        for the skill's model (``kiro_pin.kiro_model``); ``ModelRefused`` for a model Kiro has no name for, never
        Kiro's default instead. '' for a session given no model at all."""
        wanted = self.adapter.model or kiro_model(self.context.model) or ''
        if not wanted and self.context.model:
            raise ModelRefused(f'{self.context.model} has no Kiro name; choose a Kiro model for this role.')
        return wanted

    def choose_model(self, wanted: str) -> tuple[str, Mapping[str, Any]]:
        """``session/set_config_option {configId: model}``: what Kiro answers is the session's model now (recorded,
        ``acp_model``: what was asked, what Kiro answered, the models it offered when it listed them), returned with
        Kiro's answer. Kiro refusing it, not offering it on this account or answering another ends the step for a
        person (``ModelRefused``, after the ``kiro_model`` record of what was wanted and what Kiro has); ``auto`` takes
        whichever model Kiro picks."""
        words, offered, current, answer = '', [], '', {}
        try:
            answer = self.acp.wait(self.acp.request('session/set_config_option', {
                'sessionId': self.session_id, 'configId': 'model', 'value': wanted}), self.adapter.timeouts['mode'])
        except AcpTimeout:
            raise
        except AcpError as refused:
            words = _refusal(refused)
        else:
            current, offered = _current(answer, 'model'), _offered(answer, 'model')
        self.record('acp_model', wanted=wanted, current=current, offered=offered, **({'refused': words} if words else {}))
        if not words and (current == wanted or wanted == KIRO_CHOICES['auto']):
            return current, answer
        self.record('kiro_model', wanted=wanted, current=current or 'none')
        why = (f'it answered {current or "none"}' + (f': {words}' if words else '')
               + (f'; Kiro does not offer {wanted} on this account' if offered and wanted not in offered else ''))
        # (A Resume or a Restart keeps the run's models, the roles' own as its start read them: only the Restart's
        # Model, or a new run, changes them.)
        raise ModelRefused(f'Kiro could not use {wanted} for the {self.context.role} ({why}). Restart the run with '
                           'another model (Restart run, Model), or start a new run with one.')

    def choose_effort(self, model: str, options: Mapping[str, Any]) -> str:
        """``session/set_config_option {configId: effortLevel}``: the effort of the model the session asked for
        (``KIRO_EFFORT``), set after the model (Kiro's model choice resets it) unless Kiro's answer has it already; the
        effort Kiro then says it runs. One Kiro refuses or does not take is recorded (``kiro_settings``: what was
        wanted, what Kiro has) and the session goes on at Kiro's: unlike the model, the effort is the platform's
        tuning, not a person's choice. Kiro's own effort for a model the table does not name, for ``auto`` (Kiro's
        model per task) and for a session given no model."""
        wanted, current = KIRO_EFFORT.get(model, ''), _current(options, EFFORT_OPTION)
        if not wanted or current == wanted:
            return current
        words = ''
        try:
            answer = self.acp.wait(self.acp.request('session/set_config_option', {
                'sessionId': self.session_id, 'configId': EFFORT_OPTION, 'value': wanted}), self.adapter.timeouts['mode'])
        except AcpTimeout:
            raise
        except AcpError as refused:
            words = _refusal(refused)
        else:
            current = _current(answer, EFFORT_OPTION)
        if current != wanted:
            self.record('kiro_settings', **{EFFORT_OPTION: {'wanted': wanted, 'current': current or 'none',
                                                           **({'refused': words} if words else {})}})
        return current

    def load(self, session_id: str) -> tuple[bool, str]:
        """``session/load`` of the restored session (its history replayed, counted, not recorded again): whether it
        loaded, and why not. A load that times out is a crash; one kiro-cli refuses opens a new session instead."""
        self.session_id, self.replaying = session_id, True
        try:
            self.acp.wait(self.acp.request('session/load', {'sessionId': session_id, 'cwd': self.work,
                                                            'mcpServers': []}), self.adapter.timeouts['load'])
        except AcpTimeout:
            raise
        except AcpError as refused:
            self.session_id = ''
            return False, f'kiro-cli refused to load it: {str(refused)[:150]}'
        finally:
            self.replaying = False
        return True, ''

    def prompt(self, kind: str, text: str, event_ids: Sequence[str] = ()) -> int:
        """A prompt to the agent's own session (``session/prompt``, text only); mid-turn, Kiro cancels the running
        turn and goes on with this one, keeping its context."""
        self.flush_chunks()
        self.record('message', role='user', content=[{'text': text}])
        ident = self.acp.request('session/prompt', {'sessionId': self.session_id,
                                                    'prompt': [{'type': 'text', 'text': text}]})
        self.prompts[ident] = _Prompt(kind, self.adapter.clock(), list(event_ids))
        self.current = ident
        return ident

    def run(self) -> Ending:
        # (7.58.00: the session's model first, so one with no Kiro name never opens a Kiro session)
        self.wanted = self.wanted_model()
        restored = self.prepare()
        self.start()
        if self.open(restored):
            self.prompt('continue', self.continuation())
        else:
            self.prompt('open', opening(self.session))
        while True:
            alive = self.acp.pump(self.adapter.poll)
            ending = self.answers()
            if ending is not None:
                return ending
            self.seen = sync_notes(self.session, self.files, self.seen, self.turns)
            crashed = self.files.read('crashed')
            if crashed is not None:
                raise RuntimeError(f'a platform tool failed: {crashed.get("error", "")} before the task was finished')
            if self.files.read('finished') is not None:
                ending = self.after_finish()
                if ending is not None:
                    return ending
            if not alive:
                raise AcpError(f'kiro-cli ended (exit code {self.exit_code()}) before the task was finished')
            ending = self.inbox()
            if ending is not None:
                return ending
            quiet = self.adapter.clock() - self.acp.last_frame_at
            if self.current is not None and quiet > self.adapter.timeouts['stall']:
                raise AcpTimeout(f'kiro-cli said nothing for {quiet:.0f} s in the middle of a turn')

    def continuation(self) -> str:
        """The first prompt of a loaded session: it goes on; a child run's says whose task it takes over; the run's
        direction, when there is one, in the steering block."""
        parts = [CONTINUE_LOADED]
        parent = self.session.seed.get('parent') if self.from_seed and self.session.seed is not None else None
        if isinstance(parent, Mapping):
            parts.append(f'A person resumed that earlier run ({parent.get("run_id", "")}) as a new one: you take its '
                         'task over here, from where it was left.')
        direction = self.context.direction_note()
        if direction:
            parts += ["The run's direction, as the orchestrator set it:", direction]
        return '\n\n'.join(parts)

    def answers(self) -> Ending | None:
        """The prompts answered since the last look: each stop reason recorded, the steering they carried seen, and
        the current one's next step (``after_turn``)."""
        for ident in sorted(self.prompts):
            found = self.acp.answered(ident)
            if found is None:
                continue
            self.ended(ident, found.result if found.error is None else None)
            if found.error is not None:
                raise AcpError(f'kiro-cli refused a prompt: {str(found.error.get("message", ""))[:200]}')
            if ident != self.current:
                continue   # (a turn a later prompt took over: steering)
            self.current = None
            self.turns += 1
            ending = self.after_turn(str((found.result or {}).get('stopReason', '')))
            if ending is not None:
                return ending
        return None

    def ended(self, ident: int, result: Mapping[str, Any] | None) -> None:
        """A prompt's end in the transcript (its stop reason, ``error`` or ``no answer``), and its steering seen."""
        asked = self.prompts.pop(ident, None)
        if asked is None:
            return
        self.flush_chunks()
        reason = str(result.get('stopReason', '')) if result is not None else 'no answer'
        self.record('prompt_end', prompt=asked.kind, stop_reason=reason,
                    ms=int((self.adapter.clock() - asked.started) * 1000))
        if asked.event_ids:
            self.session.saw(asked.event_ids)

    def after_turn(self, reason: str) -> Ending | None:
        """A turn ended: done once the model finished; else continued (Kiro's own limits), nudged once, and done after
        a second turn without its finish (as the Converse loop's two answers without a tool: main sends that task to
        a person)."""
        self.seen = sync_notes(self.session, self.files, self.seen, self.turns)
        if self.files.read('finished') is not None:
            return self.done()
        if reason in ('max_tokens', 'max_turn_requests') and self.continues < MAX_CONTINUES:
            self.continues += 1
            self.prompt('continue', CONTINUE_LIMIT)
            return None
        if self.nudged:
            return self.done()
        self.nudged = True
        self.prompt('nudge', nudge(self.context.role))
        return None

    def after_finish(self) -> Ending | None:
        """The model called ``finish``: done once its turn ends, or cancelled after the grace."""
        if self.current is None:
            return self.done()
        now = self.adapter.clock()
        if self.finished_at is None:
            self.finished_at = now
        if now - self.finished_at < self.adapter.timeouts['finish']:
            return None
        self.cancel()
        return self.done()

    def done(self) -> Ending:
        self.end()
        self.seen = sync_notes(self.session, self.files, self.seen, self.turns)
        self.session.finished_elsewhere = self.files.read('finished') is not None
        return 'done'

    def cancel(self) -> None:
        """``session/cancel``, and the running turn's ``cancelled`` waited for (bounded)."""
        current = self.current
        if current is None:
            return
        self.acp.notify('session/cancel', {'sessionId': self.session_id})
        deadline = self.adapter.clock() + self.adapter.timeouts['cancel']
        while self.acp.waiting(current) and self.adapter.clock() < deadline:
            if not self.acp.pump(min(1.0, max(deadline - self.adapter.clock(), 0.0))):
                break
        found = self.acp.answered(current)
        self.ended(current, found.result if found is not None and found.error is None else None)
        self.current = None

    def inbox(self) -> Ending | None:
        """The inbox: a pause cancels the turn, ends kiro-cli and checkpoints (exit 75); steering becomes a prompt in
        the agent's own session; anything else waits for the tool server's next result, as data (as the CLI's)."""
        for name in [name for name in self.posted if not self.files.waiting(name)]:
            self.session.saw(self.posted.pop(name))
        others, pause = self.session.take_messages(shows=False)
        if pause:
            self.cancel()
            self.end()
            self.seen = sync_notes(self.session, self.files, self.seen, self.turns)
            self.session.paused_with(others)
            self.session.checkpoint(turn=self.turns)
            return 'paused'
        steering = [message for message in others if message.kind in (STEER, DIRECTION)]
        rest = [message for message in others if message.kind not in (STEER, DIRECTION)]
        if steering:
            # (each in the session's steering block, below the platform rules; recorded as ``steer`` events)
            self.prompt('steer', '\n\n'.join(self.context.note(message) for message in steering),
                        [message.event_id for message in steering if message.event_id])
            if TOOL in self.allowed:
                # (its tool server answers one call at a time: a wait under way would hold the steered turn's calls)
                self.files.wake()
        if rest:
            name = self.files.post([{'kind': message.kind, 'summary': message.summary, 'sender': message.sender}
                                    for message in rest])
            self.posted[name] = [message.event_id for message in rest]
        return None


def _refusal(refused: AcpError) -> str:
    """Kiro's own words for a refused request, after the client's "the agent refused request <n>: "."""
    return (str(refused).partition(': ')[2] or str(refused))[:200]


def _current(answer: Mapping[str, Any], option: str) -> str:
    """A ``set_config_option`` answer's current value of ``option`` ('' when it says none)."""
    options = answer.get('configOptions')
    found = next((item for item in options if isinstance(item, Mapping) and item.get('id') == option), None) \
        if isinstance(options, list) else None
    value = found.get('currentValue') if found is not None else None
    return value if isinstance(value, str) else ''


#: The most model ids a session's record keeps of what Kiro offered.
MAX_OFFERED: Final = 50


def _offered(answer: Mapping[str, Any], option: str) -> list[str]:
    """A ``set_config_option`` answer's values of ``option`` (its ``options``, flat or in groups), at most
    ``MAX_OFFERED`` of them; [] when it lists none."""
    options = answer.get('configOptions')
    found = next((item for item in options if isinstance(item, Mapping) and item.get('id') == option), None) \
        if isinstance(options, list) else None
    listed = found.get('options') if found is not None else None
    values: list[str] = []
    for item in listed if isinstance(listed, list) else []:
        nested = item.get('options') if isinstance(item, Mapping) else None
        for entry in nested if isinstance(nested, list) else [item]:
            value = entry.get('value') if isinstance(entry, Mapping) else None
            if isinstance(value, str) and value and value[:128] not in values:
                values.append(value[:128])
    return values[:MAX_OFFERED]


# -- Kiro's credits (7.58.00) ---------------------------------------------------------------------------------------

#: The v2 engine's own notification: several per turn, the one at a turn's end with ``meteringUsage`` (each entry
#: ``{value, unit, unitPlural}``) and ``turnDurationMs`` (checked live on kiro-cli 3.4.0 and 3.5.0, 2026-11-20).
METADATA_METHOD: Final = '_kiro.dev/metadata'
#: The v3 engine's (the harness's, ``KIRO_ARGV``): a ``session_info_update`` whose ``_meta.kiro.kind`` is
#: ``turn_completion`` carries the turn's ``promptTurnSummaries`` (each ``{usage, unit, unitPlural}``), ``elapsedTime``
#: (ms) and ``turnId``; one of kind ``session_usage`` the session's running total (``credits``), never counted (its
#: turns are). Checked live on kiro-cli 3.5.0, 2026-11-20: the v3 engine sends no ``_kiro.dev/metadata``.
TURN_COMPLETION: Final = 'turn_completion'
SESSION_USAGE: Final = 'session_usage'
CREDIT_UNIT: Final = 'credit'
#: The most credits one turn's entry is taken to say: past it, it is off its shape (recorded, never counted).
MAX_TURN_CREDITS: Final = Decimal(100_000)
#: The most entries not counted a turn's record keeps.
MAX_IGNORED: Final = 5
#: A ledger model's characters (``spend.py`` key parts): anything else in Kiro's model id becomes ``-``.
_LEDGER_MODEL: Final = re.compile(r'[^A-Za-z0-9._:/-]')


@dataclass(frozen=True)
class TurnCredits:
    """One turn's credits as kiro-cli reported them: in millionths of a credit (rounded up, never below what it said),
    the turn's milliseconds (None when it said none), its id (v3's; '' on v2), the engine's shape it came in, and the
    entries not counted (another unit, or an amount off its shape), as they came."""

    micro_credits: int
    turn_ms: int | None
    turn_id: str
    engine: str
    ignored: tuple[dict[str, Any], ...] = ()


def _kiro_meta(params: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """A ``session/update``'s ``update._meta.kiro`` (v3's own fields), None for one without it."""
    found: object = params
    for key in ('update', '_meta', 'kiro'):
        found = found.get(key) if isinstance(found, Mapping) else None
    return found if isinstance(found, Mapping) else None


def _credits(entry: object, amount: str) -> Decimal | None:
    """An entry's credits (its ``amount`` field: v2's ``value``, v3's ``usage``), None unless its unit is ``credit`` and
    its amount a number from 0 to ``MAX_TURN_CREDITS``."""
    if not isinstance(entry, Mapping) or entry.get('unit') != CREDIT_UNIT:
        return None
    raw = entry.get(amount)
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return None
    value = Decimal(str(raw))
    return value if value.is_finite() and Decimal(0) <= value <= MAX_TURN_CREDITS else None


def _shown(entry: object) -> dict[str, Any]:
    """An entry not counted, as the turn's record keeps it: a few of its fields, plain and short."""
    if not isinstance(entry, Mapping):
        return {'entry': str(entry)[:100]}
    return {str(name)[:40]: value if isinstance(value, int | float) and not isinstance(value, bool) else str(value)[:100]
            for name, value in list(entry.items())[:6]}


def turn_credits(method: str, params: Mapping[str, Any]) -> TurnCredits | None:
    """The credits a notification says one turn used, in either engine's shape (``METADATA_METHOD``'s
    ``meteringUsage``, v3's ``turn_completion``): the entries in ``credit`` summed; None for a notification that reports
    no turn's (most of them, v3's running total among them)."""
    if method == METADATA_METHOD:
        entries, elapsed, turn, engine, amount = (params.get('meteringUsage'), params.get('turnDurationMs'), '', 'v2',
                                                  'value')
    else:
        kiro = _kiro_meta(params)
        if kiro is None or kiro.get('kind') != TURN_COMPLETION:
            return None
        entries, elapsed, engine, amount = kiro.get('promptTurnSummaries'), kiro.get('elapsedTime'), 'v3', 'usage'
        turn = _LEDGER_MODEL.sub('-', str(kiro.get('turnId') or ''))[:128]
    if entries is None:
        return None
    total, ignored = Decimal(0), []
    for entry in entries if isinstance(entries, list) else [entries]:
        value = _credits(entry, amount)
        if value is None:
            ignored.append(_shown(entry))
        else:
            total += value
    micro = int((total * MICRO_PER_CREDIT).to_integral_value(rounding=ROUND_CEILING))
    turn_ms = elapsed if isinstance(elapsed, int) and not isinstance(elapsed, bool) and elapsed >= 0 else None
    return TurnCredits(micro, turn_ms, turn, engine, tuple(ignored[:MAX_IGNORED]))


def session_credits(params: Mapping[str, Any]) -> Decimal | None:
    """v3's ``session_usage``: the Kiro session's running total of credits (recorded beside its turns', never counted:
    a loaded session's total holds the turns its earlier harness sessions counted already); None for any other."""
    kiro = _kiro_meta(params)
    if kiro is None or kiro.get('kind') != SESSION_USAGE:
        return None
    entries = kiro.get('credits')
    values = [_credits(entry, 'usage') for entry in entries] if isinstance(entries, list) else []
    return sum((value for value in values if value is not None), Decimal(0))


def _tool_text(update: Mapping[str, Any]) -> str:
    """What a Kiro tool call answered: its content's text, else its raw output's message."""
    content = update.get('content')
    texts = [block['content']['text'] for block in (content if isinstance(content, list) else [])
             if isinstance(block, Mapping) and isinstance(block.get('content'), Mapping)
             and isinstance(block['content'].get('text'), str)]
    if texts:
        return '\n'.join(texts)
    raw = update.get('rawOutput')
    message = raw.get('message') if isinstance(raw, Mapping) else None
    if isinstance(message, str):
        return message
    return json.dumps(raw, default=str)[:2_000] if raw is not None else ''
