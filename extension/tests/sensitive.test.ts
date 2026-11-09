import { findEditableRoot, ineligibilityReason } from '../src/editors/sensitive';
import { CODE_EDITOR_SELECTOR } from '../src/shared/sites';

function el<T extends HTMLElement>(html: string): T {
  document.body.innerHTML = html;
  return document.body.firstElementChild as T;
}

describe('sensitive field policy', () => {
  it.each([
    ['<input type="password">', 'password'],
    ['<input type="email">', 'non-text-input'],
    ['<input type="number">', 'non-text-input'],
    ['<input type="text" autocomplete="one-time-code">', 'sensitive-autocomplete'],
    ['<input type="text" autocomplete="cc-number">', 'sensitive-autocomplete'],
    ['<input autocomplete="username">', 'sensitive-autocomplete'],
    ['<input type="text" name="otp_code">', 'sensitive-name'],
    ['<input type="text" id="cardNumber">', 'sensitive-name'],
    ['<textarea name="api_key"></textarea>', 'sensitive-name'],
    ['<input type="text" aria-label="Enter your PIN">', 'sensitive-name'],
    ['<input type="text" placeholder="Secret recovery phrase">', 'sensitive-name'],
    ['<input type="text" inputmode="numeric">', 'sensitive-name'],
    ['<textarea data-gramm="false"></textarea>', 'opt-out'],
    ['<div data-writemind="off"><textarea></textarea></div>', 'opt-out'],
    ['<textarea readonly></textarea>', 'readonly'],
    ['<input type="text" maxlength="6">', 'too-small'],
    ['<div>plain</div>', 'not-editable'],
  ])('%s → %s', (html, reason) => {
    document.body.innerHTML = html;
    const target = (document.querySelector('input, textarea') ?? document.body.firstElementChild) as HTMLElement;
    expect(ineligibilityReason(target, CODE_EDITOR_SELECTOR)).toBe(reason);
  });

  it.each([
    '<textarea name="message"></textarea>',
    '<input type="text" name="subject">',
    '<input name="title">',
    '<div contenteditable="true" role="textbox" aria-label="Message body"></div>',
  ])('allows normal writing fields: %s', (html) => {
    expect(ineligibilityReason(el(html), CODE_EDITOR_SELECTOR)).toBeNull();
  });

  it('skips code editors', () => {
    document.body.innerHTML = '<div class="cm-editor"><div contenteditable="true" class="cm-content"></div></div>';
    expect(ineligibilityReason(document.querySelector('.cm-content')!, CODE_EDITOR_SELECTOR)).toBe('code-editor');
  });

  it('skips CSS-masked inputs', () => {
    const input = el<HTMLInputElement>('<input type="text" style="-webkit-text-security: disc">');
    // jsdom does not compute vendor properties; emulate the browser's computed value.
    const original = window.getComputedStyle;
    window.getComputedStyle = ((e: Element) => {
      const style = original(e);
      return { ...style, getPropertyValue: (p: string) => (p === '-webkit-text-security' ? 'disc' : style.getPropertyValue(p)) };
    }) as typeof window.getComputedStyle;
    try {
      expect(ineligibilityReason(input)).toBe('masked');
    } finally {
      window.getComputedStyle = original;
    }
  });
});

describe('findEditableRoot', () => {
  it('returns the outermost contenteditable host', () => {
    document.body.innerHTML = '<div id="root" contenteditable="true"><p><span id="inner">hi</span></p></div>';
    const inner = document.getElementById('inner')!;
    // jsdom lacks isContentEditable inheritance; emulate it on the descendants.
    for (const n of [inner, inner.parentElement!]) Object.defineProperty(n, 'isContentEditable', { value: true });
    Object.defineProperty(document.getElementById('root')!, 'isContentEditable', { value: true });
    expect(findEditableRoot(inner)?.id).toBe('root');
  });

  it('returns form controls directly and ignores plain elements', () => {
    document.body.innerHTML = '<textarea id="t"></textarea><p id="p">x</p>';
    expect(findEditableRoot(document.getElementById('t'))?.id).toBe('t');
    expect(findEditableRoot(document.getElementById('p'))).toBeNull();
  });
});
