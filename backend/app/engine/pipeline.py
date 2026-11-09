"""The WriteMind intelligence engine: orchestrates LanguageTool, rules and AI."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import re
import time
from collections.abc import Sequence
from dataclasses import replace

from app.core.config import Settings
from app.engine.ai.corrections import issues_from_correction
from app.engine.ai.meaning_guard import compare
from app.engine.ai.provider import AIError, AIProvider
from app.engine.ai.redaction import mask
from app.engine.cache import TTLCache, cache_key
from app.engine.languagetool import LanguageToolClient, LanguageToolError, LTMatch
from app.engine.merge import merge_issues
from app.engine.offsets import Utf16Index
from app.engine.profiles import (
    Profile,
    base_confidence,
    default_title,
    map_category,
    profile_for,
    severity_for,
)
from app.engine.protect import overlaps_any, protected_spans
from app.engine.rewrite import apply_fixes, transform
from app.engine.rules import run_rules
from app.engine.segment import Segment, split_paragraphs
from app.engine.types import Issue, UserContext
from app.schemas.check import (
    CheckRequest,
    CheckResponse,
    CheckStats,
    EngineInfo,
    RewriteAlternative,
    RewriteRequest,
    RewriteResponse,
    Suggestion,
)
from app.schemas.common import Category, Severity, Source, Style

log = logging.getLogger("writemind.engine")

ENGINE_VERSION = "wm-engine-1"
_WORD = re.compile(r"[\w'’-]+")
_SEVERITY_WEIGHT = {Severity.error: 4.0, Severity.warning: 2.0, Severity.suggestion: 1.0}


def _clone(issue: Issue) -> Issue:
    return replace(issue, replacements=list(issue.replacements), agreed_by=set(issue.agreed_by))


def _looks_like_identifier(word: str) -> bool:
    """Acronyms, camelCase, words with digits/underscores: not spelling mistakes."""
    core = word.strip(".,;:!?'\"()[]{}")
    if len(core) >= 2 and core.isupper():
        return True
    if any(ch.isdigit() for ch in core) or "_" in core:
        return True
    return bool(re.search(r"[a-z][A-Z]", core))


class Engine:
    def __init__(self, settings: Settings, lt: LanguageToolClient, provider: AIProvider) -> None:
        self.settings = settings
        self.lt = lt
        self.provider = provider
        self.cache = TTLCache(settings.cache_max_entries, settings.cache_ttl_seconds)
        self._ai_semaphore = asyncio.Semaphore(4)

    # ------------------------------------------------------------------ check
    async def check(self, req: CheckRequest, ctx: UserContext) -> CheckResponse:
        started = time.perf_counter()
        text = req.text
        profile = profile_for(req.style, req.client.app)
        segments = split_paragraphs(text)

        lt_results = await asyncio.gather(
            *(self._grammar_for_segment(seg, req, profile) for seg in segments)
        )
        lt_error = any(err for _, _, err in lt_results)
        cached = sum(1 for _, hit, _ in lt_results if hit)

        ai_status, ai_issues = await self._ai_stage(segments, req, ctx)

        issues: list[Issue] = []
        for idx, seg in enumerate(segments):
            candidates = lt_results[idx][0] + ai_issues.get(idx, [])
            merged = merge_issues(candidates)
            issues.extend(i.shifted(seg.start) for i in self._filter(seg.text, merged, ctx))

        index = Utf16Index(text)
        suggestions = [self._to_suggestion(text, index, i) for i in issues]
        return CheckResponse(
            text_hash=hashlib.sha256(text.encode("utf-8")).hexdigest()[:32],
            language=req.language,
            style=req.style,
            mode=req.mode,
            suggestions=suggestions,
            stats=self._stats(text, issues),
            engine=EngineInfo(
                languagetool="error" if lt_error else "ok",
                ai=ai_status,
                paragraphs_checked=len(segments) - cached,
                paragraphs_cached=cached,
                latency_ms=round((time.perf_counter() - started) * 1000, 1),
            ),
        )

    async def _grammar_for_segment(
        self, seg: Segment, req: CheckRequest, profile: Profile
    ) -> tuple[list[Issue], bool, bool]:
        key = cache_key(
            "lt", ENGINE_VERSION, req.language, req.style.value, req.client.app or "", seg.text
        )
        hit = self.cache.get(key)
        if hit is not None:
            return [_clone(i) for i in hit], True, False
        error = False
        try:
            matches = await self.lt.check(
                seg.text,
                req.language,
                level=profile.level,
                disabled_rules=profile.disabled_rules,
                disabled_categories=profile.disabled_categories,
            )
            issues = self._from_languagetool(seg.text, matches, profile)
        except LanguageToolError:
            issues, error = [], True
        rule_issues = run_rules(
            seg.text, profile, formal=req.style is Style.formal, language=req.language
        )
        suppressed = [span for r in rule_issues for span in r.suppresses]
        if suppressed:
            issues = [
                i
                for i in issues
                if not any(i.start < e and s < max(i.end, i.start + 1) for s, e in suppressed)
            ]
        issues += rule_issues
        if not error:
            self.cache.set(key, [_clone(i) for i in issues])
        return issues, False, error

    def _from_languagetool(
        self, text: str, matches: list[LTMatch], profile: Profile
    ) -> list[Issue]:
        index = Utf16Index(text)
        issues: list[Issue] = []
        for m in matches:
            start = index.to_codepoint(m.offset)
            end = index.to_codepoint(m.offset + m.length)
            original = text[start:end]
            category = map_category(m.category_id, m.issue_type, m.rule_id)
            confidence = base_confidence(category)
            severity = severity_for(category, profile)
            if category is Category.spelling:
                if _looks_like_identifier(original):
                    continue
                before = text[:start].rstrip()
                if original[:1].isupper() and before and before[-1] not in ".!?:\n":
                    # Mid-sentence capitalised word: probably a name the speller doesn't know.
                    confidence, severity = 0.6, Severity.warning
            replacements = [r for r in m.replacements if r != original][:5]
            issues.append(
                Issue(
                    start=start,
                    end=end,
                    original=original,
                    replacements=replacements,
                    category=category,
                    severity=severity,
                    title=(m.short_message or default_title(category))[:60],
                    message=m.message,
                    rule_id=m.rule_id,
                    source=Source.languagetool,
                    confidence=confidence,
                )
            )
        return issues

    async def _ai_stage(
        self, segments: Sequence[Segment], req: CheckRequest, ctx: UserContext
    ) -> tuple[str, dict[int, list[Issue]]]:
        if not self.provider.available:
            return "unavailable", {}
        if not (req.ai and ctx.ai_enabled):
            return "disabled", {}
        if req.mode != "full":
            return "skipped", {}
        eligible = [
            (i, s)
            for i, s in enumerate(segments)
            if len(_WORD.findall(s.text)) >= 3
            and len(s.text) <= self.settings.ai_max_paragraph_chars
        ]
        if not eligible:
            return "skipped", {}

        async def run(idx: int, seg: Segment) -> tuple[int, list[Issue] | None]:
            key = cache_key("ai", ENGINE_VERSION, req.language, req.style.value, seg.text)
            hit = self.cache.get(key)
            if hit is not None:
                return idx, [_clone(i) for i in hit]
            masked = mask(seg.text)
            try:
                async with self._ai_semaphore:
                    result = await self.provider.correct(
                        masked.text, language=req.language, style=req.style.value
                    )
            except AIError as exc:
                log.warning("ai correction failed", extra={"reason": str(exc)})
                return idx, None
            issues = issues_from_correction(masked, result)
            self.cache.set(key, [_clone(i) for i in issues])
            return idx, issues

        try:
            results = await asyncio.wait_for(
                asyncio.gather(*(run(i, s) for i, s in eligible)),
                timeout=self.settings.ai_timeout_seconds + 1.0,
            )
        except TimeoutError:
            log.warning("ai stage timed out")
            return "error", {}
        found = {idx: issues for idx, issues in results if issues is not None}
        if not found:
            return "error", {}
        return "used", found

    def _filter(self, text: str, issues: list[Issue], ctx: UserContext) -> list[Issue]:
        protected = protected_spans(text)
        kept: list[Issue] = []
        for issue in issues:
            if issue.rule_id in ctx.disabled_rules or issue.category not in ctx.categories:
                continue
            if overlaps_any(issue.start, issue.end, protected):
                continue
            if issue.category is Category.spelling and ctx.dictionary:
                words = {w.lower() for w in _WORD.findall(issue.original)}
                if words and words <= ctx.dictionary:
                    continue
            issue.replacements = [r for r in issue.replacements if r != issue.original]
            if issue.source is Source.ai and not issue.replacements:
                continue
            kept.append(issue)
        return kept

    @staticmethod
    def _to_suggestion(text: str, index: Utf16Index, issue: Issue) -> Suggestion:
        offset = index.to_utf16(issue.start)
        length = index.to_utf16(issue.end) - offset
        first = issue.replacements[0] if issue.replacements else ""
        ident = hashlib.sha1(  # noqa: S324 - identifier, not security
            f"{issue.rule_id}|{offset}|{issue.original}|{first}".encode()
        ).hexdigest()[:12]
        before = text[max(0, issue.start - 12) : issue.start]
        after = text[issue.end : issue.end + 12]
        fingerprint = hashlib.sha1(  # noqa: S324
            f"{issue.rule_id}|{issue.original}|{before}|{after}".encode()
        ).hexdigest()[:16]
        return Suggestion(
            id=f"s_{ident}",
            fingerprint=fingerprint,
            offset=offset,
            length=length,
            original=issue.original,
            replacements=issue.replacements,
            category=issue.category,
            severity=issue.severity,
            title=issue.title,
            message=issue.message,
            rule_id=issue.rule_id,
            source=issue.source,
            confidence=round(issue.confidence, 2),
        )

    @staticmethod
    def _stats(text: str, issues: list[Issue]) -> CheckStats:
        words = len(_WORD.findall(text))
        sentences = sum(1 for s in re.split(r"(?<=[.!?])\s+|\n+", text) if re.search(r"\w", s))
        by_category = {c.value: 0 for c in Category}
        weighted = 0.0
        for issue in issues:
            by_category[issue.category.value] += 1
            weighted += _SEVERITY_WEIGHT[issue.severity]
        per_100 = weighted * 100.0 / max(words, 50)
        score = round(100 * math.exp(-per_100 / 30.0)) if words else 100
        return CheckStats(
            characters=len(text),
            words=words,
            sentences=sentences,
            issues=by_category,
            score=max(0, min(100, score)),
        )

    # ---------------------------------------------------------------- rewrite
    async def rewrite(self, req: RewriteRequest, ctx: UserContext) -> RewriteResponse:
        started = time.perf_counter()
        original = req.text.strip()
        alternatives: list[RewriteAlternative] = []
        seen = {_normalise(original)}
        engine = "rules"

        if self.provider.available and req.ai and ctx.ai_enabled:
            masked = mask(original)
            try:
                outputs = await asyncio.wait_for(
                    # Over-request: some candidates may be rejected by the meaning guard.
                    self.provider.rewrite(
                        masked.text,
                        language=req.language,
                        style=req.style.value,
                        count=min(req.count + 2, 5),
                    ),
                    timeout=self.settings.ai_timeout_seconds + 1.0,
                )
            except (AIError, TimeoutError) as exc:
                log.warning("ai rewrite failed", extra={"reason": type(exc).__name__})
                outputs = []
            for out in outputs:
                guard = compare(masked.text, out)
                restored = masked.restore(out).strip()
                if not guard.ok or _normalise(restored) in seen:
                    continue
                seen.add(_normalise(restored))
                alternatives.append(
                    RewriteAlternative(text=restored, source="ai", meaning_preserved=True)
                )
                engine = "ai"
                if len(alternatives) >= req.count:
                    break

        if len(alternatives) < req.count:
            for alt in await self._rule_alternatives(original, req):
                key = _normalise(alt.text)
                if key in seen:
                    continue
                seen.add(key)
                alternatives.append(alt)
                if len(alternatives) >= req.count:
                    break

        return RewriteResponse(
            style=req.style,
            alternatives=alternatives,
            engine=engine,
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
        )

    async def _rule_alternatives(self, text: str, req: RewriteRequest) -> list[RewriteAlternative]:
        fixes: list[tuple[int, int, str]] = []
        try:
            matches = await self.lt.check(text, req.language, level="default")
            issues = self._from_languagetool(text, matches, profile_for(Style.neutral, None))
            for issue in merge_issues(issues):
                if issue.category in (Category.style, Category.clarity) or not issue.replacements:
                    continue
                if issue.confidence < 0.8 or overlaps_any(
                    issue.start, issue.end, protected_spans(text)
                ):
                    continue
                fixes.append((issue.start, issue.end, issue.replacements[0]))
        except LanguageToolError:
            pass
        corrected = apply_fixes(text, fixes)
        candidates: list[tuple[str, list[str]]] = []
        if req.language.startswith("en"):
            styled = transform(corrected, req.style).strip()
            notes = [f"Adjusted for a {req.style.value} tone"]
            if fixes:
                notes.insert(0, f"{len(fixes)} correction(s) applied")
            candidates.append((styled, notes))
        if fixes:
            candidates.append((corrected.strip(), [f"{len(fixes)} correction(s) applied only"]))

        out: list[RewriteAlternative] = []
        for candidate, notes in candidates:
            if not candidate or _normalise(candidate) == _normalise(text):
                continue
            # LanguageTool fixes are corrections of the original; the style layer must not
            # change meaning relative to that corrected text.
            if not compare(corrected, candidate).ok:
                continue
            out.append(
                RewriteAlternative(
                    text=candidate, source="rules", meaning_preserved=True, notes=notes
                )
            )
        return out


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()
