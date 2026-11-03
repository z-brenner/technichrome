/** Text made safe for innerHTML: anything that came from a file, a link or a camera is shown, never interpreted. */
export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
