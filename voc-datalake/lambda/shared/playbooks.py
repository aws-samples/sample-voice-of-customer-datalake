"""The role playbooks (7.66.00, docs/playbooks.md): a short first week for a Product manager, a Scrum master, QA and
Engineering, each step linking to its screen and saying why it matters.

Content only: no permission comes with a role (the workspace role is unchanged), nothing is assigned by anyone, and
nothing here costs anything while nobody reads it. The catalogue is pinned to ``schemas/playbooks.json``, which the
SPA reads (lambda/shared/test/test_playbooks.py holds the two together): each step's id, the path of its screen, and
the evidence that ticks it:

* a SERVER signal (``SERVER_SIGNALS``), computed by ``GET /settings/my-onboarding`` (shared/onboarding.py) from the
  aggregates table in the request's scope, only for the steps of the playbook the person chose;
* what Home already reads in the browser (the person's assistant sessions, their projects, the engineering
  connections, their MCP tokens): ``BROWSER_EVIDENCE``;
* nothing: the person ticks the step (``playbook_done``).

The person's choice and their ticks live on their own onboarding row (``playbook``, ``playbook_done``). The English
texts below are the MCP prompt's (``playbook``, shared/mcp_global_prompts.py, tenet 4: the assistant's guidance in any
client); the SPA's are in its ``playbooks`` namespace, nine languages.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from shared.exceptions import ValidationError

__all__ = ['PLAYBOOKS', 'ROLES', 'ROLE_TITLES', 'STEP_IDS', 'server_signals_of', 'validate_done', 'validate_role']

#: The four roles, in the picker's order.
ROLES: Final = ('product', 'scrum_master', 'qa', 'engineering')
ROLE_TITLES: Final = {'product': 'Product manager', 'scrum_master': 'Scrum master', 'qa': 'QA',
                      'engineering': 'Engineering'}
#: The evidence the onboarding GET computes (shared/onboarding.py ``playbook_signals``).
SERVER_SIGNALS: Final = ('brief_subscribed', 'objectives_set', 'feedback_form_configured', 'form_test_response')
#: The evidence the browser already holds on Home.
BROWSER_EVIDENCE: Final = ('assistant_used', 'project_owned', 'personas_generated', 'document_written',
                           'project_shared', 'repository_connected', 'mcp_connected')


@dataclass(frozen=True)
class Step:
    """One step: its id (shared by the roles that take it), the SPA path of its screen, its evidence (None: ticked by
    the person) and, for the MCP prompt, what it is, why it matters and how an assistant helps with it."""

    id: str
    path: str
    evidence: str | None
    title: str
    why: str
    how: str


_ASK = Step('ask_assistant', '/chat', 'assistant_used', 'Ask the assistant a question about your customers',
            'It reads the feedback for you and cites every review it relies on.',
            'Answer one real question with feedback_search and feedback_get_metrics, citing feedback ids.')
_BRIEF = Step('subscribe_brief', '/account/briefing', 'brief_subscribed', 'Subscribe to the morning brief',
              'What changed overnight reaches you without opening the app.',
              'Explain what the brief holds; the person subscribes on Account → Morning brief.')
_PROJECT = Step('start_project', '/projects', 'project_owned', 'Start a research project',
                "A project keeps a theme's feedback, personas and documents together.",
                'Suggest a theme from feedback_get_metrics (view=categories); projects_list shows the ones that exist.')
_PROBLEMS = Step('review_problems', '/problems', None, 'Review the problems customers report most',
                 'The ranked problems tell you what to plan, fix or test first.',
                 'Group recent negative feedback by problem with feedback_search (sentiment=negative).')
_FORM = Step('create_form', '/feedback-forms', 'feedback_form_configured', 'Create a feedback form',
             'A form asks the questions your team needs answered, in nine languages.',
             'Help draft the questions; the person builds the form on Feedback Forms.')
_SEARCH = Step('search_feedback', '/categories', None, 'Find the feedback behind an issue',
               'The customers\' own words show how a bug or a gap is felt.',
               'Search with feedback_search for the issue in several phrasings and quote the strongest items.')

PLAYBOOKS: Final[dict[str, tuple[Step, ...]]] = {
    'product': (
        Step('read_dashboard', '/dashboard', None, "Read this week's dashboard",
             'Volume, sentiment and the top categories show where to look first.',
             'Summarise the week with feedback_get_metrics (view=summary, then categories and sentiment).'),
        _ASK,
        _PROJECT,
        Step('generate_personas', '/projects', 'personas_generated', 'Generate personas from real feedback',
             'Personas grounded in reviews keep decisions about real customers.',
             'Explain how a project generates personas; projects_get shows the ones a project has.'),
        Step('write_document', '/projects', 'document_written', 'Draft a PR/FAQ or a PRD',
             'Writing it down from the evidence makes the case for the work.',
             'Draft it in the chat from feedback_search results; the person saves it in the project.'),
        Step('set_objectives', '/account/objectives', 'objectives_set', 'Set your objectives and KPIs',
             'The assistant and the brief weigh feedback against what you are measured on.',
             'Read company_get_context and suggest objectives that fit it; the person saves them on Account.'),
        _BRIEF,
    ),
    'scrum_master': (
        _BRIEF,
        _PROBLEMS,
        Step('start_project', '/projects', 'project_owned', "Open a project for the sprint's theme",
             "A project keeps the sprint's evidence where the whole team can read it.",
             'Suggest a theme from feedback_get_metrics (view=categories); projects_list shows the ones that exist.'),
        Step('share_project', '/projects', 'project_shared', 'Share the project with your team',
             'Everyone plans from the same evidence.',
             'Explain project sharing; the person adds members on the project.'),
        Step('create_form', '/feedback-forms', 'feedback_form_configured', 'Create a form for your sprint review',
             'A short form after the review tells you what landed with the people who use it.',
             'Help draft three to five questions; the person builds the form on Feedback Forms.'),
        Step('read_form_results', '/feedback-forms', None, "Read a form's results and report",
             'The report gives you the themes and quotes to bring to the retrospective.',
             'Explain Results → Report; the person opens it on the form.'),
        Step('ask_assistant', '/chat', 'assistant_used', 'Ask the assistant for a stand-up summary',
             'Two minutes of customer signal at the start of the day.',
             'Summarise the last day with feedback_get_metrics (days=1) and two quoted items.'),
    ),
    'qa': (
        _FORM,
        Step('test_form', '/feedback-forms', 'form_test_response', 'Test a form with its test link',
             'A test response checks the questions and the logic without counting in any result.',
             "Explain the form's test link (Share tab); test responses never become feedback."),
        _SEARCH,
        _PROBLEMS,
        Step('watch_release', '/dashboard', None, 'Watch the feedback after a release',
             'A change in volume or sentiment after a release points at a regression.',
             'Compare the days before and after with feedback_get_metrics and feedback_search.'),
        _ASK,
    ),
    'engineering': (
        Step('connect_repository', '/agents/connections', 'repository_connected', 'Connect a repository',
             'The engineering agents can then turn a problem into a pull request.',
             'Explain the three ways to add a repository; an administrator connects it on Agents → Connections.'),
        _SEARCH,
        Step('run_engineering_agent', '/agents/runs', None, 'Start an engineering run from a problem',
             'An agent builds the fix, and a person reviews it before anything is pushed.',
             'Explain how a run starts from a problem; an administrator starts or confirms it on Agents.'),
        Step('build_prototype', '/projects', None, 'Build a prototype from a PRD',
             'A clickable prototype is tested with customers before it is built for real.',
             'Explain how a project builds a prototype from its PRD; documents_get reads it.'),
        Step('connect_mcp', '/connect', 'mcp_connected', 'Use VoC from your IDE',
             'Your coding assistant reads the same feedback through one MCP endpoint.',
             'Explain the Connect page: a personal token and the skill, read-only unless the person chooses write.'),
        _ASK,
    ),
}

#: Every step id of every role (a tick survives a change of role: a step two roles share keeps its tick).
STEP_IDS: Final = frozenset(step.id for steps in PLAYBOOKS.values() for step in steps)
#: At most this many ticks are kept (more than every step there is).
MAX_DONE: Final = 40


def validate_role(value: object) -> str | None:
    """A ``playbook`` choice: one of ``ROLES``, or None (no playbook). 400 otherwise."""
    if value is None or (isinstance(value, str) and value in ROLES):
        return value
    raise ValidationError(f"playbook must be one of: {', '.join(ROLES)}, or null")


def validate_done(value: object) -> list[str]:
    """A ``playbook_done`` list: known step ids, each once, at most ``MAX_DONE``, sorted. 400 otherwise."""
    if not isinstance(value, list) or len(value) > MAX_DONE:
        raise ValidationError(f'playbook_done must be a list of at most {MAX_DONE} step ids')
    if any(not isinstance(step, str) or step not in STEP_IDS for step in value):
        raise ValidationError('playbook_done names a step no playbook has')
    return sorted(set(value))


def server_signals_of(role: object) -> tuple[str, ...]:
    """The server signals the steps of ``role``'s playbook read (none without a playbook)."""
    steps = PLAYBOOKS.get(role, ()) if isinstance(role, str) else ()
    return tuple(signal for signal in SERVER_SIGNALS if any(step.evidence == signal for step in steps))
