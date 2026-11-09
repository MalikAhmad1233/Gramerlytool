import check from '../../shared/fixtures/check-response.json';
import rewrite from '../../shared/fixtures/rewrite-response.json';
import type { CheckResponse, RewriteResponse } from '../src/shared/types';

describe('API contract (fixtures captured from the real backend)', () => {
  it('check response offsets are UTF-16 and slice JavaScript strings exactly', () => {
    const response = check.response as CheckResponse;
    const text = check.request.text;
    expect(response.suggestions.length).toBeGreaterThan(0);
    for (const s of response.suggestions) {
      expect(text.slice(s.offset, s.offset + s.length)).toBe(s.original);
      expect(['grammar', 'spelling', 'punctuation', 'style', 'clarity']).toContain(s.category);
      expect(['languagetool', 'ai', 'writemind']).toContain(s.source);
      expect(s.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
    // The fixture contains an emoji before the first suggestion, so code-point offsets would fail.
    expect(text.indexOf('👋')).toBeLessThan(response.suggestions[0]!.offset);
    expect(response.stats.score).toBeGreaterThanOrEqual(0);
  });

  it('rewrite response has alternatives with provenance', () => {
    const response = rewrite.response as RewriteResponse;
    expect(response.alternatives[0]!.meaning_preserved).toBe(true);
    expect(['ai', 'rules']).toContain(response.alternatives[0]!.source);
  });
});
