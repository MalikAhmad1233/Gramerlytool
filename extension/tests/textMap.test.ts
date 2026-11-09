import { buildTextMap, domToOffset, offsetToDom, rangeFor, touchesAtom } from '../src/editors/textMap';

function editor(html: string): HTMLElement {
  document.body.innerHTML = `<div id="ed" contenteditable="true">${html}</div>`;
  return document.getElementById('ed')!;
}

describe('buildTextMap', () => {
  it('flattens Gmail-style div lines and blank lines', () => {
    const ed = editor('Hi John,<div><br></div><div>She go to school.</div><div>Thanks</div>');
    expect(buildTextMap(ed).text).toBe('Hi John,\n\nShe go to school.\nThanks');
  });

  it('flattens Lexical/Quill paragraphs and spans', () => {
    const ed = editor('<p><span data-lexical-text="true">Hello </span><b>world</b></p><p><span>Second line</span></p>');
    expect(buildTextMap(ed).text).toBe('Hello world\nSecond line');
  });

  it('normalises NBSP, tabs and source newlines without changing length', () => {
    const ed = editor('a b\tc\nd');
    const map = buildTextMap(ed);
    expect(map.text).toBe('a b c d');
    expect(map.segments[0]!.end - map.segments[0]!.start).toBe(7);
  });

  it('skips excluded subtrees such as quoted replies', () => {
    const ed = editor('My reply<div class="gmail_quote">Old teh text</div><div>Sign off</div>');
    expect(buildTextMap(ed, '.gmail_quote').text).toBe('My reply\nSign off');
  });

  it('keeps non-editable atoms as read-only text', () => {
    const ed = editor('Thanks <span contenteditable="false">@John Doe</span> for it');
    const map = buildTextMap(ed);
    expect(map.text).toBe('Thanks @John Doe for it');
    expect(touchesAtom(map, 7, 16)).toBe(true);
    expect(touchesAtom(map, 0, 6)).toBe(false);
    expect(rangeFor(map, 9, 12)).toBeNull();
  });

  it('ignores our own UI and script/style elements', () => {
    const ed = editor('Text<span data-writemind-ui="x">UI</span><script>var a</script> more');
    expect(buildTextMap(ed).text).toBe('Text more');
  });

  it('handles emoji as UTF-16 like the API', () => {
    const ed = editor('<p>Great 😀 teh plan</p>');
    const map = buildTextMap(ed);
    const offset = map.text.indexOf('teh');
    expect(offset).toBe(9); // "Great " (6) + 😀 (2 code units) + " " (1)
    const range = rangeFor(map, offset, offset + 3)!;
    expect(range.toString()).toBe('teh');
  });
});

describe('offset ↔ DOM mapping', () => {
  it('maps across multiple text nodes and lines', () => {
    const ed = editor('<p>She <i>go</i> to school.</p><p>I recieved it.</p>');
    const map = buildTextMap(ed);
    expect(map.text).toBe('She go to school.\nI recieved it.');
    const go = map.text.indexOf('go');
    expect(rangeFor(map, go, go + 2)!.toString()).toBe('go');
    const rec = map.text.indexOf('recieved');
    const range = rangeFor(map, rec, rec + 8)!;
    expect(range.toString()).toBe('recieved');
    expect(domToOffset(map, range.startContainer, range.startOffset)).toBe(rec);
  });

  it('respects boundary bias between adjacent text nodes', () => {
    const ed = editor('<span>ab</span><span>cd</span>');
    const map = buildTextMap(ed);
    const start = offsetToDom(map, 2, 'start')!;
    const end = offsetToDom(map, 2, 'end')!;
    expect(start.node.textContent).toBe('cd');
    expect(start.offset).toBe(0);
    expect(end.node.textContent).toBe('ab');
    expect(end.offset).toBe(2);
  });

  it('maps element-level selection points', () => {
    const ed = editor('<p>one</p><p>two</p>');
    const map = buildTextMap(ed);
    expect(domToOffset(map, ed, 1)).toBe(map.text.indexOf('two'));
    expect(domToOffset(map, ed, 2)).toBe(map.text.length);
  });
});
