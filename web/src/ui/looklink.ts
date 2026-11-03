// A look as a link: the parameters and print exposure deflated and base64url-encoded into the page's hash, so a
// look tuned on a desk opens on a phone (or is sent to someone) without a file. ~1 KB for the shipped look.

import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { type EngineParameters, parametersFromJSON } from '../engine/parameters';

export const LOOK_HASH_KEY = 'look';

export interface SharedLook { parameters: EngineParameters; printExposureEV: number }

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The hash fragment (without '#') carrying this look. */
export function encodeLook(look: SharedLook): string {
  const json = JSON.stringify({ ...look.parameters, printExposureEV: look.printExposureEV });
  return `${LOOK_HASH_KEY}=${base64url(deflateSync(strToU8(json), { level: 9 }))}`;
}

/** The look carried by a hash fragment ('#look=…' or 'look=…'), or null when it carries none. Throws when it is damaged. */
export function decodeLook(hash: string): SharedLook | null {
  const m = /(?:^#?|[#&])look=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(inflateSync(fromBase64url(m[1]))));
  } catch {
    throw new Error('the link does not carry a readable look');
  }
  const parameters = parametersFromJSON(json);
  const ev = (json as { printExposureEV?: unknown }).printExposureEV;
  const printExposureEV = typeof ev === 'number' && Number.isFinite(ev) ? Math.max(-2, Math.min(2, ev)) : 0;
  return { parameters, printExposureEV };
}
