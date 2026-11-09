import { TextareaAdapter } from '../src/editors/adapters';
import { isSiteDisabled } from '../src/shared/settings';
import { profileFor } from '../src/shared/sites';

describe('TextareaAdapter.apply', () => {
  function setup(value: string) {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const el = document.getElementById('t') as HTMLTextAreaElement;
    el.value = value;
    const events: string[] = [];
    el.addEventListener('input', (e) => events.push((e as InputEvent).inputType));
    return { el, events, adapter: new TextareaAdapter(el) };
  }

  it('replaces exactly the expected span and fires an input event', async () => {
    const { el, events, adapter } = setup('She go to school.');
    const result = await adapter.apply(4, 6, 'go', 'goes');
    expect(result.ok).toBe(true);
    expect(el.value).toBe('She goes to school.');
    expect(events).toContain('insertReplacementText');
    expect(el.selectionStart).toBe(8);
  });

  it('refuses to write when the text changed (never guesses)', async () => {
    const { el, adapter } = setup('She goes to school.');
    const result = await adapter.apply(4, 6, 'go', 'goes');
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(el.value).toBe('She goes to school.');
  });

  it('supports deletions', async () => {
    const { el, adapter } = setup('Send the the report');
    const result = await adapter.apply(5, 9, 'the ', '');
    expect(result.ok).toBe(true);
    expect(el.value).toBe('Send the report');
  });

  it('does not modify text on read operations', () => {
    const { el, adapter } = setup('teh text');
    adapter.getText();
    adapter.getSelection();
    expect(el.value).toBe('teh text');
  });
});

describe('site settings', () => {
  it('matches exact hosts and wildcard subdomains', () => {
    expect(isSiteDisabled('mail.google.com', ['mail.google.com'])).toBe(true);
    expect(isSiteDisabled('docs.google.com', ['mail.google.com'])).toBe(false);
    expect(isSiteDisabled('a.bank.example', ['*.bank.example'])).toBe(true);
    expect(isSiteDisabled('bank.example', ['*.bank.example'])).toBe(true);
    expect(isSiteDisabled('notbank.example', ['*.bank.example'])).toBe(false);
  });

  it('resolves site profiles', () => {
    expect(profileFor('mail.google.com').app).toBe('gmail');
    expect(profileFor('mail.google.com').excludeSelector).toContain('.gmail_quote');
    expect(profileFor('web.whatsapp.com').app).toBe('whatsapp');
    expect(profileFor('www.linkedin.com').app).toBe('linkedin');
    expect(profileFor('outlook.office.com').app).toBe('outlook');
    expect(profileFor('example.org').app).toBe('generic');
  });
});
