/**
 * Flattens a contenteditable tree into plain text plus a segment table that maps every text
 * offset back to a DOM position (and vice versa).
 *
 * - Text nodes map 1:1 (NBSP, tabs and source newlines are normalised to spaces, same length).
 * - Block boundaries and <br> become virtual "\n" characters with no DOM node.
 * - Non-editable inline atoms (mention chips, emoji images) contribute their text so grammar
 *   is checked in context, but they are marked read-only: suggestions touching them are dropped.
 * - Excluded subtrees (quoted replies, signatures) are skipped and act as paragraph breaks.
 */

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
  'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME']);

export interface TextSegment {
  start: number;
  end: number;
  node: Text | null; // null for atoms (read-only)
}

export interface TextMap {
  text: string;
  segments: TextSegment[];
}

export interface DomPoint {
  node: Node;
  offset: number;
}

export function buildTextMap(root: HTMLElement, excludeSelector: string | null = null): TextMap {
  const parts: string[] = [];
  const segments: TextSegment[] = [];
  let length = 0;

  const endsWithNewline = () => length === 0 || parts[parts.length - 1]?.endsWith('\n') === true;
  const pushVirtual = (s: string) => {
    parts.push(s);
    length += s.length;
  };
  const breakLine = () => {
    if (!endsWithNewline()) pushVirtual('\n');
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = (node as Text).data;
      if (!raw) return;
      const normalised = raw.replace(/[ \t\n\r]/g, ' ');
      segments.push({ start: length, end: length + normalised.length, node: node as Text });
      parts.push(normalised);
      length += normalised.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (SKIP_TAGS.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' && el.textContent === '') return;
    if (el.dataset?.writemindUi !== undefined) return;
    if (excludeSelector && el.matches(excludeSelector)) {
      breakLine();
      return;
    }
    if (el.tagName === 'BR') {
      pushVirtual('\n');
      return;
    }
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt') ?? '';
      if (alt) {
        segments.push({ start: length, end: length + alt.length, node: null });
        pushVirtual(alt);
      }
      return;
    }
    if (el !== root && el.getAttribute('contenteditable') === 'false') {
      const atom = (el.textContent ?? '').replace(/[ \t\n\r]/g, ' ');
      if (atom) {
        segments.push({ start: length, end: length + atom.length, node: null });
        pushVirtual(atom);
      }
      return;
    }
    const block = el !== root && BLOCK_TAGS.has(el.tagName);
    if (block) breakLine();
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    if (block) breakLine();
  };

  for (let child = root.firstChild; child; child = child.nextSibling) walk(child);
  let text = parts.join('');
  // Trailing virtual newline (from a final block) is not part of the user's text.
  if (text.endsWith('\n') && !segments.some((s) => s.end === text.length)) text = text.slice(0, -1);
  return { text, segments };
}

/** True if any part of [start, end) lies on a read-only atom. */
export function touchesAtom(map: TextMap, start: number, end: number): boolean {
  return map.segments.some((s) => s.node === null && start < s.end && s.start < Math.max(end, start + 1));
}

/**
 * Maps a text offset to a DOM point. `bias` decides which side wins at a boundary between two
 * segments: range starts prefer the following text node, range ends the preceding one.
 */
export function offsetToDom(map: TextMap, offset: number, bias: 'start' | 'end'): DomPoint | null {
  const segs = map.segments;
  let lo = 0;
  let hi = segs.length - 1;
  let candidate: TextSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid]!;
    if (offset < s.start) hi = mid - 1;
    else if (offset > s.end) lo = mid + 1;
    else {
      candidate = s;
      // Prefer the neighbour that contains the offset strictly inside, per bias.
      if (bias === 'start' && offset === s.end && segs[mid + 1]?.start === offset) candidate = segs[mid + 1]!;
      if (bias === 'end' && offset === s.start && segs[mid - 1]?.end === offset) candidate = segs[mid - 1]!;
      break;
    }
  }
  if (candidate) {
    if (!candidate.node) return null;
    return { node: candidate.node, offset: offset - candidate.start };
  }
  // Offset sits on a virtual newline: snap to the nearest real text position.
  if (bias === 'start') {
    const next = segs.find((s) => s.start >= offset && s.node);
    return next?.node ? { node: next.node, offset: 0 } : null;
  }
  const prev = [...segs].reverse().find((s) => s.end <= offset && s.node);
  return prev?.node ? { node: prev.node, offset: prev.end - prev.start } : null;
}

export function rangeFor(map: TextMap, start: number, end: number): Range | null {
  if (touchesAtom(map, start, end)) return null;
  const a = offsetToDom(map, start, 'start');
  const b = offsetToDom(map, end, 'end');
  if (!a || !b) return null;
  const doc = a.node.ownerDocument;
  if (!doc) return null;
  const range = doc.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Maps a DOM point (e.g. the selection) back to a text offset. */
export function domToOffset(map: TextMap, node: Node, offset: number): number | null {
  for (const s of map.segments) {
    if (s.node === node) return s.start + Math.min(offset, s.end - s.start);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const child = node.childNodes[offset] ?? null;
    // Position before `child`: first segment inside or after it.
    for (const s of map.segments) {
      if (!s.node) continue;
      if (child && (child === s.node || child.contains(s.node) || child.compareDocumentPosition(s.node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        return s.start;
      }
    }
    return map.text.length;
  }
  return null;
}
