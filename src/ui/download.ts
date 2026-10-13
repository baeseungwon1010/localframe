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
    .slice(0, 100)
    // no names of only dots, no trailing dots or spaces (Windows drops them)
    .replace(/[. ]+$/, '');
  if (!cleaned || /^\.+$/.test(cleaned)) return fallback;
  // names Windows reserves for devices
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned;
}
