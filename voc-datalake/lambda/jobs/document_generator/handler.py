"""
Document Generator Job Lambda Handler

Generates PRD or PR-FAQ documents using multi-step LLM chains with project context.
Uses the same prompt templates and chain patterns as the synchronous projects.py path.
"""

import os
import re
import sys
from datetime import datetime, timezone

# Add parent directory to path for shared module imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from boto3.dynamodb.conditions import Key

from shared.logging import logger, tracer, metrics
from shared.jobs import job_handler, JobContext, update_job_status
from shared.aws import get_dynamodb_resource
from shared.converse import converse_chain
from shared.feedback import query_feedback_by_date
from shared.api import validate_date_basis
from shared.prompts import get_prd_generation_steps, get_prfaq_generation_steps

# Environment
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
# Scratch bucket for the claim-check pattern (see step handlers below). Step
# Functions state has a 256KB ceiling; PRD/PR-FAQ step outputs (long CJK docs,
# 30-90KB each, accumulated across 3-4 steps) blow past it. So intermediate
# step text lives in S3 and only the small S3 keys travel through SF state.
# This is also the bucket that hosts generated HTML prototypes (see
# _prototype_s3_key/_prototype_url below) — same bucket, different prefixes
# ("scratch/document_jobs/*" vs "prototypes/*").
SCRATCH_BUCKET = os.environ.get('RAW_DATA_BUCKET', '')
# Public-ish CloudFront URL for the /prototypes/* cache behavior (see
# core-stack.ts) that serves prototype HTML with its own permissive CSP,
# isolated from the main SPA's strict CSP. e.g. https://<domain>/prototypes
PROTOTYPES_CDN_URL = os.environ.get('PROTOTYPES_CDN_URL', '').rstrip('/')


def _gather_context(
    ctx: JobContext,
    projects_table,
    feedback_table,
    project_id: str,
    doc_config: dict,
) -> tuple[str, str]:
    """Gather feedback, document, and persona context for document generation.

    Returns:
        (feedback_context, personas_context) formatted for LLM prompts.
    """
    data_sources = doc_config.get('data_sources', {})
    feedback_context = ''
    personas_context = ''

    # Gather feedback
    if data_sources.get('feedback'):
        ctx.update_progress(20, 'fetching_feedback')
        feedback_items = query_feedback_by_date(
            feedback_table,
            days=doc_config.get('days', 30),
            sources=doc_config.get('feedback_sources') or None,
            categories=doc_config.get('feedback_categories') or None,
            limit=100,
            # doc_config is the raw request body, so validate here (issue #150).
            date_basis=validate_date_basis(doc_config.get('date_basis')),
        )
        if feedback_items:
            parts = []
            for i, item in enumerate(feedback_items[:30], 1):
                parts.append(
                    f"**Review {i}** ({item.get('source_platform', 'unknown')}, "
                    f"{item.get('sentiment_label', 'unknown')}): "
                    f"{item.get('original_text', '')[:300]}"
                )
            feedback_context = '\n\n'.join(parts)

    # Query project items once if we need personas or documents
    all_project_items = []
    needs_project_items = data_sources.get('personas') or data_sources.get('documents') or data_sources.get('research')
    if needs_project_items:
        resp = projects_table.query(KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'))
        all_project_items = resp.get('Items', [])

    # Gather personas
    if data_sources.get('personas'):
        ctx.update_progress(30, 'fetching_personas')
        selected_ids = doc_config.get('selected_persona_ids', [])
        personas = [i for i in all_project_items if i.get('sk', '').startswith('PERSONA#')]
        if selected_ids:
            personas = [p for p in personas if p.get('persona_id') in selected_ids]
        if personas:
            parts = []
            for p in personas:
                parts.append(
                    f"**{p.get('name')}**: {p.get('tagline', '')}\n"
                    f"- Goals: {', '.join(p.get('goals', [])[:3])}\n"
                    f"- Frustrations: {', '.join(p.get('frustrations', [])[:3])}"
                )
            personas_context = '\n\n'.join(parts)

    # Gather reference documents and append to feedback context
    if data_sources.get('documents') or data_sources.get('research'):
        ctx.update_progress(40, 'fetching_documents')
        selected_ids = doc_config.get('selected_document_ids', [])
        docs = [i for i in all_project_items if i.get('sk', '').startswith(('RESEARCH#', 'PRD#', 'PRFAQ#', 'DOC#'))]
        if selected_ids:
            docs = [d for d in docs if d.get('document_id') in selected_ids]
        if docs:
            doc_parts = []
            for d in docs[:3]:
                doc_parts.append(f"### {d.get('title', 'Untitled')}\n{d.get('content', '')[:3000]}")
            doc_text = "## Reference Documents\n\n" + '\n\n'.join(doc_parts)
            feedback_context = f"{feedback_context}\n\n{doc_text}" if feedback_context else doc_text

    return feedback_context, personas_context


def _generate_prd(ctx: JobContext, feature_idea: str, feedback_context: str,
                  personas_context: str, doc_config: dict,
                  product_context: str = "(No product context provided.)") -> tuple[str, dict]:
    """Generate PRD using multi-step LLM chain.

    Returns:
        (content, analysis) where analysis contains problem/solution intermediate results.
    """
    chain_steps = get_prd_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context,
        response_language=doc_config.get('response_language'),
    )

    def progress_callback(progress, step):
        # Map chain progress (15-75%) into our 50-85% range
        mapped = 50 + int((progress - 15) / 60 * 35)
        ctx.update_progress(mapped, step)

    results = converse_chain(chain_steps, progress_callback=progress_callback)

    # results[0] = problem_analysis, results[1] = solution_design, results[2] = prd_document
    content = results[2] if len(results) >= 3 else results[-1]
    analysis = {}
    if len(results) >= 3:
        analysis = {'problem': results[0], 'solution': results[1]}

    return content, analysis


def _generate_prfaq(ctx: JobContext, feature_idea: str, feedback_context: str,
                    personas_context: str, doc_config: dict,
                    product_context: str = "(No product context provided.)") -> tuple[str, dict]:
    """Generate PR-FAQ using multi-step LLM chain.

    Returns:
        (content, sections) where sections contains all intermediate results.
    """
    chain_steps = get_prfaq_generation_steps(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context,
        response_language=doc_config.get('response_language'),
    )

    def progress_callback(progress, step):
        mapped = 50 + int((progress - 15) / 60 * 35)
        ctx.update_progress(mapped, step)

    results = converse_chain(chain_steps, progress_callback=progress_callback)

    # results[0] = customer_thinking, [1] = press_release, [2] = customer_faq, [3] = internal_faq
    full_document = f"""# PR/FAQ: {feature_idea}

## Press Release

{results[1] if len(results) > 1 else ''}

---

## Frequently Asked Questions

### Customer FAQ

{results[2] if len(results) > 2 else ''}

### Internal FAQ

{results[3] if len(results) > 3 else ''}
"""

    sections = {}
    if len(results) >= 4:
        sections = {
            'customer_insights': results[0],
            'press_release': results[1],
            'customer_faq': results[2],
            'internal_faq': results[3],
        }

    return full_document, sections


# ── Prototype builder ────────────────────────────────────────────────────────
#
# The prototype generator returns a STRUCTURED JSON SPEC — not HTML, not React
# code. The frontend renders the spec using its own React components. This
# eliminates a stack of failures that plagued previous attempts to render
# arbitrary HTML inside an iframe (CSP blocks, sandbox attribute permutations,
# Babel auto-scanner timing, srcDoc/blob URL inconsistency).
#
# Spec shape (all fields optional except `screens`):
# {
#   "title": "...",
#   "banner": "Prototype demo — Feature Name",
#   "screens": [
#     {
#       "id": "home",
#       "label": "홈",                    # tab label
#       "heading": "...",
#       "subheading": "...",
#       "blocks": [                       # rendered top-to-bottom
#         { "type": "text", "text": "..." },
#         { "type": "list", "title": "...", "items": [{ "title": "...", "subtitle": "...", "badge": "..." }] },
#         { "type": "stats", "items": [{ "label": "...", "value": "..." }] },
#         { "type": "form", "title": "...", "fields": [{ "label": "...", "placeholder": "..." }],
#                                          "submit": { "label": "Submit", "goto": "screen-id" } },
#         { "type": "callout", "tone": "info|success|warn|error", "text": "..." },
#         { "type": "buttons", "items": [{ "label": "...", "goto": "screen-id", "tone": "primary|secondary" }] }
#       ]
#     }
#   ]
# }

# ── HTML prototype builder (Opus 4.8) ─────────────────────────────────────────
#
# Newer path: instead of a constrained JSON spec, ask the model for a single,
# self-contained, offline-first HTML file (inline CSS + minimal vanilla JS, no
# external CDNs/fonts/scripts). The frontend renders it in a sandboxed <iframe
# srcdoc>. The offline-first constraint is exactly what sidesteps the old
# iframe/CSP failures that pushed us to the JSON spec: no external loads means
# nothing to block, and sandbox="allow-scripts" runs the inline nav JS safely.
#
# Adapted from the "Prototype Builder" CLAUDE.md. Brand is resolved from
# doc_config (named brand → use it; otherwise neutral defaults) and the brief.
PROTOTYPE_HTML_SYSTEM_PROMPT = """You are a clickable prototype builder. The user brings a PRD / PR-FAQ / brief; you produce a SINGLE, self-contained, clickable HTML prototype that looks and feels like a real product.

You are NOT building a real application — only a visual, click-through mockup a stakeholder can open in a browser and tap through.

OUTPUT FORMAT (strict):
- Output ONE complete HTML document and NOTHING else. Start with <!DOCTYPE html> and end with </html>.
- No prose, no explanation, no markdown code fences before or after the HTML.

THE HARD RULES:
- Everything in one HTML file: inline <style> and inline <script>. No separate files.
- OFFLINE-FIRST — this is mandatory and non-negotiable: NO external CDNs, NO external fonts (system font stack only), NO external scripts, NO external images, NO API/network calls, NO tracking. Icons and logos as inline SVG. Anything external will be blocked by the sandbox and break the demo.
- No frameworks, no build tooling, no router. Plain HTML + a little vanilla JS only.
- Make it clickable: buttons/tabs/links navigate between screens via simple show/hide or in-page anchors with a tiny bit of inline vanilla JS. Multiple screens in one file, toggled by JS.
- Use realistic placeholder content drawn from the brief so the demo feels real. No "Lorem ipsum".
- If the brief needs a real backend (login, payment, booking, chat), FAKE it visually — success screen, confirmation modal, or a fake spinner. Never wire real services.
- Match the language of the source documents (Korean source → Korean UI text).

LOOK & FEEL:
- Theme everything from CSS :root custom properties: --primary, --primary-light, --soft, --tint, --bg, --ink, --gray, --surface. Use --primary boldly for primary CTAs and active states against the soft bg/tint with generous whitespace.
- System font stack: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif.
- Rounded corners (12-20px), soft shadows, gentle hover transitions. Clean and premium.
- Render the wordmark as inline SVG or styled text — never an external image.

LAYOUT:
- Default to a mobile phone-shell: center content in a ~420px shell with a sticky bottom tab bar, unless the brief is clearly a desktop/web product (then use a full-width top-nav layout).
- Mobile-first CSS with a @media (min-width: 768px) refinement so it also looks good on desktop.

BRAND:
- If a brand is specified below, infer and apply that brand's palette, wordmark style, product nouns, and whether it's a mobile app or web product.
- If no brand is specified, use neutral defaults: an indigo primary (#4F46E5 / light #818CF8 / soft #E0E7FF / tint #EEF2FF / bg #FBFBFD / ink #1A1A1A / gray #6B7280 / surface #FFFFFF), a clean modern SaaS aesthetic, generic tabs (Home, Explore, Activity, Profile), and pull all content from the brief.

Produce a polished, tap-through prototype. Remember: ONE HTML document, output nothing but the HTML."""

PROTOTYPE_HTML_USER_TEMPLATE = """Build a clickable HTML prototype for the product/feature below. Output ONE complete HTML document only — no prose, no code fences.

PROJECT: {project_name}
{brand_section}{prd_section}{prfaq_section}

Requirements:
- Single self-contained HTML file (inline CSS + vanilla JS), offline-first, no external resources.
- 3-6 clickable screens toggled by inline JS, with a navigation bar.
- Realistic placeholder content from the brief above.
- {lang_hint}"""


def _strip_html_fences(s: str) -> str:
    """The model sometimes wraps output in ``` fences; strip them."""
    s = s.strip()
    if s.startswith('```'):
        lines = s.splitlines()
        if lines and lines[0].startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith('```'):
            lines = lines[:-1]
        s = '\n'.join(lines).strip()
    return s


def _extract_html(raw: str) -> str:
    """Pull a complete HTML document out of the model's reply.

    Tolerates ``` fences and any stray prose before/after the document by
    slicing from the first <!DOCTYPE/<html to the last </html>. Returns '' if
    no recognizable HTML is present.
    """
    s = _strip_html_fences(raw or '')
    low = s.lower()
    start = low.find('<!doctype html')
    if start == -1:
        start = low.find('<html')
    if start == -1:
        return ''
    end = low.rfind('</html>')
    if end == -1:
        # Truncated output — keep from the start anyway; the iframe is tolerant.
        return s[start:].strip()
    return s[start:end + len('</html>')].strip()


def _prototype_s3_key(project_id: str, doc_id: str) -> str:
    return f"prototypes/{project_id}/{doc_id}.html"


def _prototype_url(project_id: str, doc_id: str) -> str:
    return f"{PROTOTYPES_CDN_URL}/{project_id}/{doc_id}.html"


def _put_prototype_html(project_id: str, doc_id: str, html: str) -> None:
    """Write generated prototype HTML to S3 under the /prototypes/* prefix that
    the frontendDistribution's second cache behavior serves (core-stack.ts).
    Prototypes are S3-only — no DynamoDB `content` field is written for new
    prototypes (see FEATURE-isolated-prototype-hosting.md); only `prototype_url`
    is persisted on the ProjectDocument item.
    """
    _s3().put_object(
        Bucket=SCRATCH_BUCKET,
        Key=_prototype_s3_key(project_id, doc_id),
        Body=html.encode('utf-8'),
        ContentType='text/html; charset=utf-8',
    )


def _get_prototype_html(project_id: str, doc_id: str) -> str:
    """Read a previously generated prototype's HTML back from S3. Used by
    feedback-driven regeneration, which needs the prior prototype's content to
    revise rather than start from scratch.
    """
    obj = _s3().get_object(Bucket=SCRATCH_BUCKET, Key=_prototype_s3_key(project_id, doc_id))
    return obj['Body'].read().decode('utf-8')


def _latest_doc_by_prefix(projects_table, project_id: str, sk_prefix: str) -> dict | None:
    """
    Return the most recently created document of a given type for the project,
    or None if none exist. We can't use a GSI here because prefixes are encoded
    in `sk` directly; small project tables make a query+filter cheap enough.
    """
    from boto3.dynamodb.conditions import Key
    resp = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with(sk_prefix),
        ScanIndexForward=False,  # newest first by sk
        Limit=20,
    )
    items = resp.get('Items') or []
    if not items:
        return None
    items.sort(key=lambda i: i.get('created_at', ''), reverse=True)
    return items[0]


def _generate_prototype(ctx, projects_table, project_id: str, job_id: str, doc_config: dict) -> dict:
    """
    Build a self-contained, offline-first HTML prototype from the latest PRD and
    PR/FAQ for this project, save it as a ProjectDocument of type 'prototype' with
    prototype_format='html'. The frontend renders the HTML in a sandboxed
    <iframe srcdoc> so inline CSS/JS run in isolation. Opus 4.8 builds the HTML.
    """
    from shared.converse import converse

    prd = _latest_doc_by_prefix(projects_table, project_id, 'PRD#')
    prfaq = _latest_doc_by_prefix(projects_table, project_id, 'PRFAQ#')

    if not prd and not prfaq:
        raise RuntimeError('No PRD or PR/FAQ found for this project. Generate at least one first.')

    proj_resp = projects_table.get_item(Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'})
    project_name = (proj_resp.get('Item') or {}).get('name') or 'Project'

    title = doc_config.get('title') or f"Prototype: {project_name}"

    PER_DOC_CAP = 12000
    prd_text = (prd or {}).get('content', '')[:PER_DOC_CAP]
    prfaq_text = (prfaq or {}).get('content', '')[:PER_DOC_CAP]

    prd_section = f'\n\nPRD:\n{prd_text}' if prd_text else ''
    prfaq_section = f'\n\nPR/FAQ:\n{prfaq_text}' if prfaq_text else ''

    lang = (doc_config.get('response_language') or 'en')[:5]
    lang_hint = 'Write the UI text in Korean.' if lang.startswith('ko') else 'Match the language of the brief.'

    # Optional brand targeting: doc_config.brand (e.g. "UNNI" or a domain). When
    # absent, the system prompt's neutral defaults apply.
    brand = (doc_config.get('brand') or '').strip()
    brand_section = f'BRAND: {brand}\n' if brand else ''

    # Optional feedback-driven regeneration: when the user gives feedback on an
    # existing prototype, we re-generate CENTERED on that feedback while still
    # honoring the PRD/PR-FAQ. We include the prior prototype HTML so the model
    # revises it (e.g. "switch to an admin-facing view") rather than starting over.
    feedback = (doc_config.get('feedback') or '').strip()
    base_prototype_id = (doc_config.get('base_prototype_id') or '').strip()
    feedback_section = ''
    system_prompt = PROTOTYPE_HTML_SYSTEM_PROMPT
    if feedback:
        prior_html = ''
        if base_prototype_id:
            base = projects_table.get_item(
                Key={'pk': f'PROJECT#{project_id}', 'sk': f'PROTOTYPE#{base_prototype_id}'}
            ).get('Item') or {}
            # New (S3-only) prototypes have no `content` field — read the HTML
            # back from S3 via prototype_url instead. Old (pre-migration)
            # prototypes still have `content` inline in DynamoDB; fall back to
            # that so revising a pre-fix prototype still works.
            if base.get('prototype_url'):
                try:
                    prior_html = _get_prototype_html(project_id, base_prototype_id)
                except Exception as e:
                    logger.warning(f"Failed to read prior prototype HTML from S3: {e}")
                    prior_html = base.get('content', '')
            else:
                prior_html = base.get('content', '')
        # Cap the prior HTML so the prompt stays within budget; the model gets
        # enough to understand structure/style and revise it toward the feedback.
        PRIOR_CAP = 24000
        prior_block = f'\n\nEXISTING PROTOTYPE (revise this):\n{prior_html[:PRIOR_CAP]}' if prior_html else ''
        feedback_section = (
            f'\n\nUSER FEEDBACK — make this the PRIMARY focus of the revision:\n{feedback}\n'
            'Revise the prototype to center on this feedback (e.g. change perspective, add/replace '
            'screens, adjust flows) while STILL staying consistent with the PRD/PR-FAQ above. '
            'Keep the offline-first single-HTML rules. Output the full revised HTML document.'
            f'{prior_block}'
        )

    user_prompt = PROTOTYPE_HTML_USER_TEMPLATE.format(
        project_name=project_name,
        brand_section=brand_section,
        prd_section=prd_section,
        prfaq_section=prfaq_section,
        lang_hint=lang_hint,
    ) + feedback_section

    ctx.update_progress(40, 'invoking_bedrock')
    # Opus 4.8 for the prototype build — stronger frontend/design instincts than
    # the default chat model. converse() accepts a per-call model override.
    raw = converse(
        prompt=user_prompt,
        system_prompt=system_prompt,
        model_id='global.anthropic.claude-opus-4-8',
        max_tokens=32000,
        temperature=None,  # Opus 4.8 deprecates the temperature inference param.
        step_name='build_prototype',
    )

    html = _extract_html(raw)
    if not html:
        raise RuntimeError('Prototype model did not return an HTML document.')

    ctx.update_progress(80, 'saving_prototype')

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    doc_id = f"prototype_{now_dt.strftime('%Y%m%d%H%M%S')}"

    # S3-only storage: the HTML is served directly from the /prototypes/* cache
    # behavior (core-stack.ts), so DynamoDB only stores the URL, not the content
    # itself. This also means the frontend's live preview, "Open in new tab",
    # and "Download .html" never need the raw HTML in memory — they're all URL
    # consumers now (no more Blob/createObjectURL indirection).
    _put_prototype_html(project_id, doc_id, html)
    prototype_url = _prototype_url(project_id, doc_id)

    ctx.update_progress(90, 'saving_document')

    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'PROTOTYPE#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': 'prototype',
        'title': title,
        'prototype_url': prototype_url,
        # 'html' → frontend renders via <iframe src=prototype_url>.
        # Older prototypes have no prototype_format and are JSON specs (legacy).
        'prototype_format': 'html',
        'job_id': job_id,
        'source_prd_id': (prd or {}).get('document_id'),
        'source_prfaq_id': (prfaq or {}).get('document_id'),
        'created_at': now,
    }
    if feedback:
        # Record that this prototype is a feedback-driven revision of a prior one.
        item['revised_from_id'] = base_prototype_id or None
        item['revision_feedback'] = feedback[:2000]
    projects_table.put_item(Item=item)
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = if_not_exists(document_count, :zero) + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':zero': 0, ':now': now},
    )
    ctx.update_progress(100, 'saved')
    return {'document_id': doc_id, 'title': title}


@job_handler(error_message='Document generation failed')
def handle_job(ctx: JobContext, project_id: str, job_id: str, doc_config: dict) -> dict:
    """Handle async document generation job (PRD/PRFAQ).

    Uses multi-step LLM chains loaded from prompt templates for higher quality
    output and better support for CJK languages.

    Args:
        ctx: Job context for progress updates
        project_id: Project ID
        job_id: Job ID
        doc_config: Document configuration (doc_type, title, feature_idea, data_sources, etc.)

    Returns:
        Result dict with document_id and title
    """
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    feedback_table = dynamodb.Table(FEEDBACK_TABLE)

    ctx.update_progress(10, 'gathering_context')

    doc_type = doc_config.get('doc_type', 'prd')
    title = doc_config.get('title', 'Untitled')
    feature_idea = doc_config.get('feature_idea', '')

    # Product/Service Description report — reuse the existing generate_report
    # function (which already does its own Bedrock call + DynamoDB write).
    # We branch here so the Generate-report button can run async without API
    # Gateway's 29s ceiling tripping it.
    if doc_type == 'product_report':
        try:
            from api.product_context import generate_report as pc_generate_report
        except Exception as e:
            raise RuntimeError(f'product_context module not available: {e}')
        ctx.update_progress(50, 'generating_report')
        result = pc_generate_report(project_id, {
            'response_language': doc_config.get('response_language'),
            'title': title or doc_config.get('title'),
        })
        ctx.update_progress(100, 'saved')
        doc_item = result.get('document', {})
        return {
            'document_id': doc_item.get('document_id'),
            'title': doc_item.get('title'),
        }

    # Build Prototype — generate a single-file HTML React/Tailwind demo from
    # the source PRD/PR-FAQ. Display via iframe srcdoc; no compile step.
    if doc_type == 'build_prototype':
        ctx.update_progress(20, 'loading_source_documents')
        return _generate_prototype(ctx, projects_table, project_id, job_id, doc_config)

    feedback_context, personas_context = _gather_context(
        ctx, projects_table, feedback_table, project_id, doc_config
    )

    # Inject the per-project product/service context (structured fields + uploaded internal docs).
    try:
        from api.product_context import build_product_context_block
        product_context_str = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context_str = "(No product context provided.)"

    ctx.update_progress(50, 'generating_document')

    if doc_type == 'prd':
        content, analysis = _generate_prd(ctx, feature_idea, feedback_context, personas_context, doc_config, product_context_str)
    else:
        content, analysis = _generate_prfaq(ctx, feature_idea, feedback_context, personas_context, doc_config, product_context_str)

    ctx.update_progress(90, 'saving_document')
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    doc_id = f"{doc_type}_{now_dt.strftime('%Y%m%d%H%M%S')}"

    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'{doc_type.upper()}#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': doc_type,
        'title': title,
        'feature_idea': feature_idea,
        'content': content,
        'job_id': job_id,
        'created_at': now,
    }
    if analysis:
        item['analysis'] = analysis

    projects_table.put_item(Item=item)
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = if_not_exists(document_count, :zero) + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':zero': 0, ':now': now}
    )

    return {'document_id': doc_id, 'title': title}


# ── Step Functions step handlers ─────────────────────────────────────────────
#
# PRD/PR-FAQ generation is a multi-step LLM chain where each step can itself run
# for minutes (each step's output is long, and the converse() auto-continuation
# resumes truncated output across several Bedrock calls). Running the whole chain
# in one Lambda invocation overruns the 15-minute Lambda ceiling for long CJK
# documents. So we split the chain across Lambda invocations orchestrated by a
# Step Functions state machine — each LLM step gets its own fresh 15-minute
# budget, and output is never truncated to fit. This mirrors the research
# workflow (research_step_handler.py).
#
# State flow (Step Functions passes results between invocations):
#   gather   → build chain steps + context  → {steps, doc_type, title, feature_idea}
#   run_step → execute ONE chain step (index i), return its text
#   save     → assemble final document, persist to DynamoDB
#
# `steps` carries each chain step's system/user/max_tokens. `results` accumulates
# each step's output text. `{previous}` in a step's user prompt is substituted
# with the prior step's result, exactly like converse_chain does.

from shared.converse import converse  # noqa: E402  (used by run_step)


# ── Claim-check S3 helpers ───────────────────────────────────────────────────
# Step Functions state is capped at 256KB; long step prompts/outputs don't fit.
# We stash them in S3 under a per-job prefix and pass only the key in SF state.
# The whole prefix is best-effort cleaned at save time.

def _scratch_key(job_id: str, name: str) -> str:
    return f"scratch/document_jobs/{job_id}/{name}.txt"


def _s3():
    import boto3
    return boto3.client('s3')


def _put_text(key: str, text: str) -> str:
    _s3().put_object(Bucket=SCRATCH_BUCKET, Key=key, Body=text.encode('utf-8'))
    return key


def _get_text(key: str) -> str:
    return _s3().get_object(Bucket=SCRATCH_BUCKET, Key=key)['Body'].read().decode('utf-8')


def _build_steps(project_id: str, job_id: str, doc_config: dict) -> dict:
    """gather step: fetch context, build chain steps, stash them in S3.

    Each chain step (system/user prompt with context injected) can be tens of KB,
    so the step list goes to S3 and only its key rides through SF state.
    """
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    feedback_table = dynamodb.Table(FEEDBACK_TABLE)

    ctx = JobContext(project_id, job_id)
    ctx.update_progress(10, 'gathering_context')

    doc_type = doc_config.get('doc_type', 'prd')
    feature_idea = doc_config.get('feature_idea', '')

    feedback_context, personas_context = _gather_context(
        ctx, projects_table, feedback_table, project_id, doc_config
    )

    try:
        from api.product_context import build_product_context_block
        product_context_str = build_product_context_block(project_id)
    except Exception as e:
        logger.warning(f"Failed to build product context: {e}")
        product_context_str = "(No product context provided.)"

    builder = get_prd_generation_steps if doc_type == 'prd' else get_prfaq_generation_steps
    chain_steps = builder(
        feature_idea=feature_idea,
        personas_context=personas_context,
        feedback_context=feedback_context,
        product_context=product_context_str,
        response_language=doc_config.get('response_language'),
    )

    import json as _json
    _put_text(_scratch_key(job_id, 'steps'), _json.dumps(chain_steps))

    ctx.update_progress(15, 'context_ready')
    # S3 keys are deterministic from (job_id, index), so SF state carries only
    # scalars — no growing arrays — which keeps every state transition tiny.
    return {
        'doc_type': doc_type,
        'title': doc_config.get('title', 'Untitled'),
        'feature_idea': feature_idea,
        'num_steps': len(chain_steps),
    }


def _run_one_step(project_id: str, job_id: str, index: int) -> None:
    """run_step: execute a single chain step in its own Lambda invocation.

    Reads the step list and the previous step's output from S3 (deterministic
    keys), runs converse() (which auto-continues past maxTokens internally, with
    a full 15-min Lambda budget to itself), writes this step's output to S3.
    """
    import json as _json
    steps = _json.loads(_get_text(_scratch_key(job_id, 'steps')))
    step = steps[index]
    total = len(steps)
    step_name = step.get('step_name', f'llm_step_{index + 1}')

    # Map step progress into the 15-85% band so the UI shows steady movement.
    progress = 15 + int((index / total) * 70)
    JobContext(project_id, job_id).update_progress(progress, step_name)

    previous = _get_text(_scratch_key(job_id, f'result_{index - 1}')) if index > 0 else ''
    user = step.get('user', '').replace('{previous}', previous)

    logger.info(f"[DOCSTEP] step {index + 1}/{total} '{step_name}': max_tokens={step.get('max_tokens', 4096)}")
    result = converse(
        prompt=user,
        system_prompt=step.get('system', ''),
        max_tokens=step.get('max_tokens', 4096),
        thinking_budget=step.get('thinking_budget', 0),
        step_name=step_name,
    )
    logger.info(f"[DOCSTEP] step '{step_name}' produced {len(result)} chars")
    _put_text(_scratch_key(job_id, f'result_{index}'), result)


def _assemble_and_save(project_id: str, job_id: str, doc_type: str, title: str,
                       feature_idea: str, num_steps: int) -> dict:
    """save step: read step outputs from S3, assemble the document, persist."""
    dynamodb = get_dynamodb_resource()
    projects_table = dynamodb.Table(PROJECTS_TABLE)
    JobContext(project_id, job_id).update_progress(90, 'saving_document')

    results = [_get_text(_scratch_key(job_id, f'result_{i}')) for i in range(num_steps)]

    analysis = {}
    if doc_type == 'prd':
        # results = [problem_analysis, solution_design, prd_document]
        content = results[2] if len(results) >= 3 else results[-1]
        if len(results) >= 3:
            analysis = {'problem': results[0], 'solution': results[1]}
    else:
        # results = [customer_thinking, press_release, customer_faq, internal_faq]
        content = f"""# PR/FAQ: {feature_idea}

## Press Release

{results[1] if len(results) > 1 else ''}

---

## Frequently Asked Questions

### Customer FAQ

{results[2] if len(results) > 2 else ''}

### Internal FAQ

{results[3] if len(results) > 3 else ''}
"""
        if len(results) >= 4:
            analysis = {
                'customer_insights': results[0],
                'press_release': results[1],
                'customer_faq': results[2],
                'internal_faq': results[3],
            }

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    doc_id = f"{doc_type}_{now_dt.strftime('%Y%m%d%H%M%S')}"
    item = {
        'pk': f'PROJECT#{project_id}',
        'sk': f'{doc_type.upper()}#{doc_id}',
        'gsi1pk': f'PROJECT#{project_id}#DOCUMENTS',
        'gsi1sk': now,
        'document_id': doc_id,
        'document_type': doc_type,
        'title': title,
        'feature_idea': feature_idea,
        'content': content,
        'job_id': job_id,
        'created_at': now,
    }
    if analysis:
        item['analysis'] = analysis

    projects_table.put_item(Item=item)
    projects_table.update_item(
        Key={'pk': f'PROJECT#{project_id}', 'sk': 'META'},
        UpdateExpression='SET document_count = if_not_exists(document_count, :zero) + :one, updated_at = :now',
        ExpressionAttributeValues={':one': 1, ':zero': 0, ':now': now}
    )

    # Best-effort cleanup of the scratch prefix for this job.
    try:
        keys = [{'Key': _scratch_key(job_id, 'steps')}] + \
               [{'Key': _scratch_key(job_id, f'result_{i}')} for i in range(num_steps)]
        _s3().delete_objects(Bucket=SCRATCH_BUCKET, Delete={'Objects': keys})
    except Exception as e:
        logger.warning(f"Scratch cleanup failed (non-fatal): {e}")

    update_job_status(
        project_id, job_id, 'completed', 100, 'complete',
        result={'document_id': doc_id, 'title': title}
    )
    return {'document_id': doc_id, 'title': title}


def _handle_step_error(event: dict) -> dict:
    """error step: mark the job failed (mirrors research step_error)."""
    project_id = event['project_id']
    job_id = event['job_id']
    error = event.get('error', {})
    raw_cause = error.get('Cause', '{}') if isinstance(error, dict) else str(error)
    try:
        import json as _json
        cause = _json.loads(raw_cause)
        error_message = cause.get('errorMessage') or raw_cause
    except (ValueError, TypeError):
        error_message = raw_cause or 'Unknown error'
    logger.error(f"Document job {job_id} failed: {error_message}")
    update_job_status(project_id, job_id, 'failed', 0, 'error', error=str(error_message)[:500])
    return {'success': False, 'error': str(error_message)[:500]}


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context) -> dict:
    """Lambda entry point.

    Two invocation shapes:
      1. Step Functions step  — event has a 'step' key ('gather'|'run_step'|'save'|'error').
         Used for PRD/PR-FAQ so each LLM step gets its own 15-min Lambda budget.
      2. Direct async invoke   — legacy single-shot path (product_report,
         build_prototype, and any caller not going through the state machine).
    """
    step = event.get('step')
    logger.info(f"Document generator invoked: step={step}, keys={list(event.keys())}")

    if step is None:
        # Legacy single-invocation path (prototype, product_report, or fallback).
        return handle_job(event)

    project_id = event['project_id']
    job_id = event['job_id']

    if step == 'gather':
        return _build_steps(project_id, job_id, event['doc_config'])

    if step == 'run_step':
        _run_one_step(project_id, job_id, event['index'])
        return {'index': event['index']}

    if step == 'save':
        return _assemble_and_save(
            project_id, job_id,
            event['doc_type'], event['title'], event['feature_idea'],
            event['num_steps'],
        )

    if step == 'error':
        return _handle_step_error(event)

    raise ValueError(f"Unknown step: {step}")
