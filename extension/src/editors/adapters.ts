import { spanStillValid } from '../core/rebase';
import { TextareaMirror, type Rect } from './mirror';
import { buildTextMap, domToOffset, rangeFor, touchesAtom, type TextMap } from './textMap';

export type ApplyResult =
  | { ok: true; method: 'execCommand' | 'beforeinput' | 'paste' | 'setter' }
  | { ok: false; reason: 'stale' | 'blocked' | 'failed'; copied?: boolean };

/**
 * Uniform access to an editable field. Adapters only *read* text and geometry; `apply` is the
 * single write path and is only ever invoked from an explicit user action (Accept / Replace).
 */
export interface EditorAdapter {
  readonly element: HTMLElement;
  readonly kind: 'textarea' | 'input' | 'contenteditable';
  getText(): string;
  getRects(start: number, end: number): Rect[];
  getBounds(): DOMRect;
  getSelection(): { start: number; end: number } | null;
  canEdit(start: number, end: number): boolean;
  /** `wholeWords` (default true) also rejects spans that became part of a longer word. */
  apply(start: number, end: number, expected: string, replacement: string, wholeWords?: boolean): Promise<ApplyResult>;
  dispose(): void;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

function valid(text: string, start: number, end: number, expected: string, wholeWords: boolean): boolean {
  return wholeWords ? spanStillValid(text, start, end, expected) : text.slice(start, end) === expected;
}

function waitFrame(win: Window): Promise<void> {
  return new Promise((resolve) => {
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

async function settled(win: Window, check: () => boolean, frames = 4): Promise<boolean> {
  if (check()) return true;
  for (let i = 0; i < frames; i++) {
    await waitFrame(win);
    if (check()) return true;
  }
  return false;
}

async function copyToClipboard(doc: Document, text: string): Promise<boolean> {
  try {
    await doc.defaultView?.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function execEdit(doc: Document, replacement: string): boolean {
  try {
    return replacement ? doc.execCommand('insertText', false, replacement) : doc.execCommand('delete', false);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------- textarea/input

export class TextareaAdapter implements EditorAdapter {
  readonly kind: 'textarea' | 'input';
  private readonly mirror: TextareaMirror;

  constructor(readonly element: HTMLTextAreaElement | HTMLInputElement) {
    this.kind = element instanceof HTMLTextAreaElement ? 'textarea' : 'input';
    this.mirror = new TextareaMirror(element);
  }

  getText(): string {
    return this.element.value;
  }

  getBounds(): DOMRect {
    return this.element.getBoundingClientRect();
  }

  getRects(start: number, end: number): Rect[] {
    return this.mirror.rects(start, end);
  }

  getSelection(): { start: number; end: number } | null {
    const { selectionStart, selectionEnd } = this.element;
    if (selectionStart === null || selectionEnd === null) return null;
    return { start: selectionStart, end: selectionEnd };
  }

  canEdit(): boolean {
    return true;
  }

  async apply(start: number, end: number, expected: string, replacement: string, wholeWords = true): Promise<ApplyResult> {
    const el = this.element;
    const doc = el.ownerDocument;
    const win = doc.defaultView!;
    const before = el.value;
    if (!valid(before, start, end, expected, wholeWords)) return { ok: false, reason: 'stale' };
    const target = before.slice(0, start) + replacement + before.slice(end);

    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    // execCommand keeps the native undo stack and fires real input events (React/Vue see them).
    if (execEdit(doc, replacement) && (await settled(win, () => el.value === target))) {
      return { ok: true, method: 'execCommand' };
    }
    if (el.value === before) {
      const proto = el instanceof HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, target);
      const caret = start + replacement.length;
      el.setSelectionRange(caret, caret);
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: replacement }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      if (el.value === target) return { ok: true, method: 'setter' };
    }
    return { ok: false, reason: 'failed', copied: await copyToClipboard(doc, replacement) };
  }

  dispose(): void {
    this.mirror.dispose();
  }
}

// ---------------------------------------------------------------------------- contenteditable

export class ContentEditableAdapter implements EditorAdapter {
  readonly kind = 'contenteditable' as const;
  private cache: { version: number; map: TextMap } | null = null;
  private version = 0;
  private readonly observer: MutationObserver;

  constructor(
    readonly element: HTMLElement,
    private readonly excludeSelector: string | null,
  ) {
    const win = element.ownerDocument.defaultView!;
    this.observer = new win.MutationObserver(() => {
      this.version++;
    });
    this.observer.observe(element, { childList: true, characterData: true, subtree: true });
  }

  map(): TextMap {
    // MutationObserver callbacks are async, so also compare text length cheaply for staleness.
    if (!this.cache || this.cache.version !== this.version) {
      this.cache = { version: this.version, map: buildTextMap(this.element, this.excludeSelector) };
    }
    return this.cache.map;
  }

  private fresh(): TextMap {
    this.cache = null;
    return this.map();
  }

  getText(): string {
    return this.fresh().text;
  }

  getBounds(): DOMRect {
    return this.element.getBoundingClientRect();
  }

  getRects(start: number, end: number): Rect[] {
    const map = this.map();
    const doc = this.element.ownerDocument;
    const rects: Rect[] = [];
    for (const seg of map.segments) {
      if (!seg.node || seg.end <= start || seg.start >= Math.max(end, start + 1)) continue;
      const range = doc.createRange();
      range.setStart(seg.node, Math.max(0, start - seg.start));
      range.setEnd(seg.node, Math.min(seg.end, end) - seg.start);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width > 0 || start === end) rects.push({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
    }
    return rects;
  }

  getSelection(): { start: number; end: number } | null {
    const sel = this.element.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!this.element.contains(range.startContainer) || !this.element.contains(range.endContainer)) return null;
    const map = this.fresh();
    const start = domToOffset(map, range.startContainer, range.startOffset);
    const end = domToOffset(map, range.endContainer, range.endOffset);
    if (start === null || end === null) return null;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  canEdit(start: number, end: number): boolean {
    return !touchesAtom(this.map(), start, end);
  }

  async apply(start: number, end: number, expected: string, replacement: string, wholeWords = true): Promise<ApplyResult> {
    const el = this.element;
    const doc = el.ownerDocument;
    const win = doc.defaultView!;
    const map = this.fresh();
    if (!valid(map.text, start, end, expected, wholeWords)) return { ok: false, reason: 'stale' };
    if (!rangeFor(map, start, end)) return { ok: false, reason: 'blocked' };
    const before = normalise(map.text);
    const target = normalise(map.text.slice(0, start) + replacement + map.text.slice(end));
    const current = () => normalise(buildTextMap(el, this.excludeSelector).text);
    const done = () => current() === target;
    const select = (): boolean => {
      const range = rangeFor(this.fresh(), start, end);
      const sel = doc.getSelection();
      if (!range || !sel) return false;
      el.focus({ preventScroll: true });
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    };

    // 1. Native editing command: undo-friendly, understood by Gmail, Quill, Lexical, ProseMirror.
    if (select() && execEdit(doc, replacement) && (await settled(win, done, 6))) {
      return { ok: true, method: 'execCommand' };
    }
    // 2. Editors that own their DOM model listen to beforeinput.
    if (current() === before && select()) {
      const event = new win.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: replacement ? 'insertReplacementText' : 'deleteContent',
        data: replacement,
      });
      el.dispatchEvent(event);
      if (await settled(win, done, 6)) return { ok: true, method: 'beforeinput' };
    }
    // 3. Synthetic paste, handled by most rich-text frameworks.
    if (current() === before && replacement && select()) {
      try {
        const data = new win.DataTransfer();
        data.setData('text/plain', replacement);
        el.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        if (await settled(win, done, 6)) return { ok: true, method: 'paste' };
      } catch {
        /* DataTransfer unavailable */
      }
    }
    // Never touch innerHTML behind the editor's back. Hand the text to the user instead.
    return { ok: false, reason: 'failed', copied: await copyToClipboard(doc, replacement) };
  }

  dispose(): void {
    this.observer.disconnect();
  }
}

export function createAdapter(el: HTMLElement, excludeSelector: string | null): EditorAdapter {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return new TextareaAdapter(el);
  return new ContentEditableAdapter(el, excludeSelector);
}
