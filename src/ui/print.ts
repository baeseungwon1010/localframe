/**
 * Vector PDF through the browser's print dialog: each SVG becomes one page of its own size.
 * The SVGs go in as images, so their ids and styles can't clash.
 */
export async function printSvgPages(pages: { svg: string; width: number; height: number }[], title: string): Promise<void> {
  if (pages.length === 0) throw new Error('Nothing to print');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const css: string[] = ['html,body{margin:0;padding:0}', 'img{display:block}'];
  const body: string[] = [];
  pages.forEach((p, i) => {
    const w = Math.max(1, Math.round(p.width));
    const h = Math.max(1, Math.round(p.height));
    css.push(`@page p${i}{size:${w}px ${h}px;margin:0}`, `.p${i}{page:p${i};width:${w}px;height:${h}px;break-after:page}`);
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.svg)}`;
    body.push(`<div class="p${i}"><img src="${esc(src)}" width="${w}" height="${h}" alt=""></div>`);
  });
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css.join('')}</style></head><body>${body.join('')}</body></html>`;
  document.body.append(frame);
  try {
    await new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    const win = frame.contentWindow;
    if (!win) throw new Error('The print view did not open');
    await Promise.all([...win.document.images].map((img) => img.decode().catch(() => {})));
    win.focus();
    win.print();
  } finally {
    // print() blocks until the dialog closes in most browsers; give others a moment
    setTimeout(() => frame.remove(), 1000);
  }
}
