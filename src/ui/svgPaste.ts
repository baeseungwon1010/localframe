/**
 * Pasted text that is an SVG drawing (copied from a design tool or an icon site): after an XML
 * declaration, comments and a doctype, an <svg> tag. Read step by step, not with one regex, so a
 * long paste can never make it slow.
 */
export function looksLikeSvg(text: string): boolean {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  for (let guard = 0; guard < 1000; guard++) {
    skipSpace();
    const close = text.startsWith('<?', i) ? '?>' : text.startsWith('<!--', i) ? '-->' : text.startsWith('<!', i) && !text.startsWith('<![', i) ? '>' : null;
    if (!close) break;
    const end = text.indexOf(close, i + 2);
    if (end < 0) return false;
    i = end + close.length;
  }
  return /^<svg[\s>/]/i.test(text.slice(i, i + 5));
}
