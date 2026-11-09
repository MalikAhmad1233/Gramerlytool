/**
 * Privacy rule R3: WriteMind never reads password, payment, one-time-code or other sensitive
 * fields, and respects page/user opt-outs. This runs *before* any text is read.
 */

const TEXT_INPUT_TYPES = new Set(['', 'text']);

const SENSITIVE_AUTOCOMPLETE =
  /\b(current-password|new-password|one-time-code|cc-[a-z-]+|username|email|tel(?:-[a-z-]+)?|street-address|address-line\d|address-level\d|postal-code|country|bday(?:-[a-z]+)?|transaction-amount|webauthn)\b/i;

const SENSITIVE_NAME =
  /pass(word|wd|code|phrase)?|pwd|secret|token|otp|one.?time|2fa|mfa|totp|\bpin\b|cvv|cvc|csc|ssn|social.?sec|tax.?id|iban|swift|bic\b|card.?(number|no)|cc.?num|account.?(number|no)|routing|api.?key|private.?key|seed.?phrase|mnemonic/i;

const OPT_OUT_SELECTOR =
  '[data-writemind="off"], [data-writemind="false"], [data-gramm="false"], [data-gramm_editor="false"], [data-enable-grammarly="false"]';

export type Ineligibility =
  | 'not-editable'
  | 'password'
  | 'non-text-input'
  | 'sensitive-autocomplete'
  | 'sensitive-name'
  | 'opt-out'
  | 'masked'
  | 'readonly'
  | 'code-editor'
  | 'too-small';

function attr(el: Element, name: string): string {
  return el.getAttribute(name) ?? '';
}

function describes(el: Element): string {
  return [
    attr(el, 'name'),
    attr(el, 'id'),
    attr(el, 'aria-label'),
    attr(el, 'placeholder'),
    attr(el, 'data-testid'),
    attr(el, 'class'),
  ].join(' ');
}

/** Returns why a field must not be checked, or null if it is eligible. */
export function ineligibilityReason(el: HTMLElement, codeEditorSelector?: string): Ineligibility | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return 'password';
    if (!TEXT_INPUT_TYPES.has(el.type.toLowerCase()) && el.getAttribute('type') !== null) return 'non-text-input';
    if (el.readOnly || el.disabled) return 'readonly';
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.readOnly || el.disabled) return 'readonly';
  } else if (!el.isContentEditable && el.getAttribute('contenteditable') !== 'true') {
    return 'not-editable';
  }

  if (el.closest(OPT_OUT_SELECTOR)) return 'opt-out';
  if (SENSITIVE_AUTOCOMPLETE.test(attr(el, 'autocomplete'))) return 'sensitive-autocomplete';
  if (SENSITIVE_NAME.test(describes(el))) return 'sensitive-name';
  if (el instanceof HTMLInputElement && el.inputMode === 'numeric') return 'sensitive-name';

  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  const security = style?.getPropertyValue('-webkit-text-security');
  if (security && security !== 'none') return 'masked';

  if (codeEditorSelector && el.closest(codeEditorSelector)) return 'code-editor';
  if (el instanceof HTMLInputElement && el.maxLength > 0 && el.maxLength < 20) return 'too-small';
  return null;
}

export function isSensitiveOrIneligible(el: HTMLElement, codeEditorSelector?: string): boolean {
  return ineligibilityReason(el, codeEditorSelector) !== null;
}

/** Finds the editable root for an event target (the outermost contenteditable host). */
export function findEditableRoot(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target;
  if (!target.isContentEditable && target.getAttribute('contenteditable') !== 'true') return null;
  let root: HTMLElement = target;
  while (root.parentElement && (root.parentElement.isContentEditable || root.parentElement.getAttribute('contenteditable') === 'true')) {
    root = root.parentElement;
  }
  return root;
}
