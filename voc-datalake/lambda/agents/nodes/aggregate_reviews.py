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

PER_CATEGORY_LIMIT = 100
MAX_REVIEWS_IN_PROMPT = 60
MAX_REVIEW_CHARS = 280
DEFAULT_DAYS = 7
MAX_PROBLEMS = 5

SYSTEM = (
    'You analyse customer feedback for a product team. Group the reviews into concrete problems, '
    'most impactful first, and cite review ids. Answer with ONE JSON object only: '
    '{"title": str, "problem_summary": str, "research_question": str, "top_problems": '
    '[{"title": str, "category": str, "subcategory": str|null, "review_ids": [str], '
    '"evidence_count": int}]}. ' + context_blocks.DATA_NOTICE
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


def _review_line(item: dict) -> str:
    text = str(item.get('original_text') or item.get('text') or '').replace('\n', ' ')
    return (f"[{item.get('feedback_id')}] ({item.get('category') or '-'} / "
            f"{item.get('subcategory') or '-'}, {item.get('sentiment_label') or '-'}, "
            f"urgency {item.get('urgency') or '-'}) {text[:MAX_REVIEW_CHARS]}")


def _clean_problems(raw: Any, known_ids: set[str]) -> list[dict]:
    problems = []
    for problem in raw if isinstance(raw, list) else []:
        if not isinstance(problem, dict) or not isinstance(problem.get('title'), str):
            continue
        ids = [i for i in problem.get('review_ids') or [] if isinstance(i, str) and i in known_ids]
        problems.append({
            'title': problem['title'][:200],
            'category': str(problem.get('category') or '')[:100],
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
    memory_query = ' '.join(
        str(r.get('problem_summary') or r.get('original_text') or '')[:200] for r in selected[:10]
    )
    prompt = context_blocks.join_blocks(
        context_blocks.company_context(),
        context_blocks.memories(ctx.claims, memory_query),
        context_blocks.wrap('conductor_message', ctx.envelope, 6000),
        context_blocks.wrap('reviews', '\n'.join(_review_line(r) for r in selected), 30000),
        'Return the JSON object now.',
    )
    answer = llm.parse_json_object(ctx.ask(prompt, system_prompt=SYSTEM, max_tokens=2500))
    if not answer:
        raise NodeFailure('the review analysis was not valid JSON')
    known = {str(r.get('feedback_id')) for r in selected}
    problems = _clean_problems(answer.get('top_problems'), known)
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
