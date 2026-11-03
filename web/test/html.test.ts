import { describe, expect, it } from 'vitest';
import { escapeHTML } from '../src/ui/html';

describe('escapeHTML', () => {
  it('neutralises markup and leaves plain text alone', () => {
    expect(escapeHTML('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHTML("Technichrome v1 & 'dusk'")).toBe('Technichrome v1 &amp; &#39;dusk&#39;');
    expect(escapeHTML('Apple iPhone13,3 back camera · 3024×4032')).toBe('Apple iPhone13,3 back camera · 3024×4032');
  });
});
