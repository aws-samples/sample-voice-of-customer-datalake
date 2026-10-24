"""aggregate_reviews — the top problems among the reviews in the agent's scope.

Reviews are read through ``GET /feedback`` on the metrics Lambda as the agent
principal, so the owner's category access bounds what the agent sees; the
agent's own scope narrows it further (one query per scoped category). The
worker summarises them into cited problems. No reviews → the run halts as
completed (nothing to do).
"""
from __future__ import annotations

from typing import Any

from agents import context_blocks, llm, principal
from agents.nodes.base import NodeContext, NodeFailure, done, scope_categories
from shared.display_labels import humanize_id
from shared.prompt_labels import PromptLabels
from shared.prompt_labels_store import load_prompt_labels
from shared.tables import get_aggregates_table

PER_CATEGORY_LIMIT = 100
MAX_REVIEWS_IN_PROMPT = 60
MAX_REVIEW_CHARS = 280
DEFAULT_DAYS = 7
MAX_PROBLEMS = 5
# Answer budget (``llm.invoke`` adds AGENT_THINKING_HEADROOM). The answer is strict JSON from
# ONE call, and its size is driven by the cited ids: up to MAX_PROBLEMS problems may each cite
# every one of the MAX_REVIEWS_IN_PROMPT reviews (``evidence_count`` counts them all), and a
# 32-hex feedback id costs ~18 tokens quoted, and the prose fields ~600 (5 x 60 x 18 + 600 = 6000).
# Live-caught at 2500: "still truncated after 0 continuation(s)" with 2603 characters.
_CITED_ID_TOKENS = 18
_PROSE_TOKENS = 600
#: Labels without a category config: the humanised ids.
_NO_CONFIG = PromptLabels()
ANSWER_TOKENS = MAX_PROBLEMS * MAX_REVIEWS_IN_PROMPT * _CITED_ID_TOKENS + _PROSE_TOKENS

SYSTEM = (
    'You analyse customer feedback for a product team. Group the reviews into concrete problems, '
    'most impactful first, and cite review ids. Answer with ONE JSON object only: '
    '{"title": str, "problem_summary": str, "research_question": str, "top_problems": '
    '[{"title": str, "category": str, "subcategory": str|null, "review_ids": [str], '
    '"evidence_count": int}]}. "category" and "subcategory" are the ids in square brackets after each '
    "review's labels; everywhere else refer to categories, subcategories and sources by these names, "
    'never by their ids. ' + context_blocks.DATA_NOTICE
)


def _fetch(ctx: NodeContext, days: int) -> list[dict]:
    categories = scope_categories(ctx.agent) or [None]
    seen: dict[str, dict] = {}
    for category in categories:
        query: dict[str, Any] = {'days': days, 'limit': PER_CATEGORY_LIMIT}
        if category:
            query['category'] = category
        payload = principal.metrics('GET', '/feedback', ctx.claims, query=query)
        items = payload.get('items') if isinstance(payload, dict) else None
        for item in items if isinstance(items, list) else []:
            feedback_id = item.get('feedback_id') if isinstance(item, dict) else None
            if isinstance(feedback_id, str) and feedback_id not in seen:
                seen[feedback_id] = item
    return list(seen.values())


def _priority(item: dict) -> tuple:
    urgency = {'high': 0, 'medium': 1, 'low': 2}.get(str(item.get('urgency')), 3)
    sentiment = item.get('sentiment_score')
    return (urgency, sentiment if isinstance(sentiment, (int, float)) else 0)


def _named(label: str, value: object) -> str:
    """``Label [id]`` — the model writes the label and answers the id."""
    return f'{label} [{value}]' if value else '-'


def _review_line(item: dict, labels: PromptLabels = _NO_CONFIG) -> str:
    text = str(item.get('original_text') or item.get('text') or '').replace('\n', ' ')
    category, subcategory, source = item.get('category'), item.get('subcategory'), item.get('source_platform')
    source_part = f'{labels.source(source)}, ' if source else ''
    return (f"[{item.get('feedback_id')}] ({_named(labels.category(category), category)} / "
            f"{_named(labels.subcategory(subcategory, category), subcategory)}, "
            f"{source_part}{item.get('sentiment_label') or '-'}, "
            f"urgency {item.get('urgency') or '-'}) {text[:MAX_REVIEW_CHARS]}")


def _clean_problems(raw: Any, known_ids: set[str], labels: PromptLabels = _NO_CONFIG) -> list[dict]:
    problems = []
    for problem in raw if isinstance(raw, list) else []:
        if not isinstance(problem, dict) or not isinstance(problem.get('title'), str):
            continue
        ids = [i for i in problem.get('review_ids') or [] if isinstance(i, str) and i in known_ids]
        category = str(problem.get('category') or '')[:100]
        # A configured label is kept with the problem (later prompts and summaries read it);
        # without one the humanised id is derived where it is read (nodes/base.py).
        label = labels.category(category) if category else ''
        problems.append({
            'title': problem['title'][:200],
            'category': category,
            **({'category_label': label} if label and label != humanize_id(category) else {}),
            'subcategory': str(problem.get('subcategory') or '')[:100] or None,
            'review_ids': ids[:20],
            'evidence_count': len(ids),
        })
    return problems[:MAX_PROBLEMS]


def start(ctx: NodeContext) -> dict:
    days = ctx.param('days', DEFAULT_DAYS)
    days = days if isinstance(days, int) and 0 < days <= 365 else DEFAULT_DAYS
    reviews = sorted(_fetch(ctx, days), key=_priority)
    if not reviews:
        return done(ctx, f'No reviews in scope in the last {days} days; nothing to do.', halt=True)
    selected = reviews[:MAX_REVIEWS_IN_PROMPT]
    labels = load_prompt_labels(get_aggregates_table())  # names for the prompt; ids stay in the answer
    memory_query = ' '.join(
        str(r.get('problem_summary') or r.get('original_text') or '')[:200] for r in selected[:10]
    )
    prompt = context_blocks.join_blocks(
        context_blocks.company_context(),
        context_blocks.memories(ctx.claims, memory_query),
        context_blocks.wrap('conductor_message', ctx.envelope, 6000),
        context_blocks.wrap('reviews', '\n'.join(_review_line(r, labels) for r in selected), 30000),
        'Return the JSON object now.',
    )
    answer = llm.parse_json_object(ctx.ask(prompt, system_prompt=SYSTEM, max_tokens=ANSWER_TOKENS))
    if not answer:
        raise NodeFailure('the review analysis was not valid JSON')
    known = {str(r.get('feedback_id')) for r in selected}
    problems = _clean_problems(answer.get('top_problems'), known, labels)
    if not problems:
        raise NodeFailure('the review analysis named no problems backed by reviews')
    aggregate = {
        'title': str(answer.get('title') or problems[0]['title'])[:200],
        'problem_summary': str(answer.get('problem_summary') or '')[:2000],
        'research_question': str(answer.get('research_question') or '')[:500],
        'top_problems': problems,
        'review_count': len(reviews),
        'days': days,
    }
    return done(
        ctx, f"{len(reviews)} reviews → {len(problems)} problems; top: {problems[0]['title']}",
        updates={'aggregate': aggregate},
    )
