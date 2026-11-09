/**
 * Geometry for <textarea>/<input>: text inside these controls has no DOM ranges, so we lay the
 * same text out in an invisible "mirror" element with identical typography and measure there.
 */

const COPIED_PROPERTIES = [
  'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
  'lineHeight', 'fontFamily', 'fontFeatureSettings', 'fontKerning',
  'textAlign', 'textTransform', 'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
  'tabSize', 'MozTabSize', 'direction', 'writingMode',
] as const;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export class TextareaMirror {
  private readonly host: HTMLDivElement;

  constructor(private readonly el: HTMLTextAreaElement | HTMLInputElement) {
    this.host = el.ownerDocument.createElement('div');
    this.host.setAttribute('data-writemind-ui', 'mirror');
    this.host.setAttribute('aria-hidden', 'true');
    el.ownerDocument.body.appendChild(this.host);
  }

  dispose(): void {
    this.host.remove();
  }

  /** Client rects (viewport coordinates) covering [start, end) — one per visual line. */
  rects(start: number, end: number): Rect[] {
    const el = this.el;
    const win = el.ownerDocument.defaultView;
    if (!win) return [];
    const computed = win.getComputedStyle(el);
    const style = this.host.style;
    for (const prop of COPIED_PROPERTIES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (style as any)[prop] = (computed as any)[prop];
    }
    const isInput = el instanceof HTMLInputElement;
    style.position = 'absolute';
    style.visibility = 'hidden';
    style.pointerEvents = 'none';
    style.top = '0';
    style.left = '-99999px';
    style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
    style.overflowWrap = isInput ? 'normal' : 'break-word';
    style.overflow = 'hidden';
    if (!isInput) style.height = 'auto';
    // Scrollbars reduce the content width of the real textarea.
    style.width = `${el.clientWidth + parseFloat(computed.borderLeftWidth) + parseFloat(computed.borderRightWidth)}px`;
    if (computed.boxSizing !== 'border-box') {
      style.width = `${el.clientWidth - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight)}px`;
    }

    const value = el.value;
    const doc = el.ownerDocument;
    this.host.textContent = '';
    const before = doc.createTextNode(value.slice(0, start));
    const target = doc.createElement('span');
    target.textContent = value.slice(start, end) || '​';
    const after = doc.createTextNode(value.slice(end) || ' ');
    this.host.append(before, target, after);

    const hostRect = this.host.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const out: Rect[] = [];
    for (const r of Array.from(target.getClientRects())) {
      out.push({
        left: elRect.left + (r.left - hostRect.left) - el.scrollLeft,
        top: elRect.top + (r.top - hostRect.top) - el.scrollTop,
        width: r.width,
        height: r.height,
      });
    }
    return out;
  }
}
