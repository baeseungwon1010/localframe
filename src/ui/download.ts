export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name that is safe on every OS. */
export function safeFileName(name: string, fallback = 'export'): string {
  const cleaned = name
    // path separators, reserved characters, control and bidi characters (which can fake an extension)
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}
