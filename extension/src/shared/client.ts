import { browser } from 'wxt/browser';
import type { Envelope, Request, ResponseFor } from './messages';
import { WriteMindError } from './messages';

/** Typed request to the background service worker. */
export async function send<T extends Request>(message: T): Promise<ResponseFor<T['type']>> {
  let envelope: Envelope<ResponseFor<T['type']>> | undefined;
  try {
    envelope = (await browser.runtime.sendMessage(message)) as Envelope<ResponseFor<T['type']>>;
  } catch {
    throw new WriteMindError('extension_reloaded', 'WriteMind was updated. Reload the page to continue.');
  }
  if (!envelope) throw new WriteMindError('no_response', 'No response from WriteMind.');
  if (!envelope.ok) throw new WriteMindError(envelope.error.code, envelope.error.message);
  return envelope.data;
}
