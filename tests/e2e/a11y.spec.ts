import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility checks across the main screens, light and dark: every control has a name a screen
 * reader can say, text meets WCAG AA contrast, keyboard focus is visible, and the canvas says what
 * is selected.
 */

const audit = (p: Page, where: string) =>
  p.evaluate((where) => {
    const out: string[] = [];
    const vis = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const name = (el: Element) => {
      const h = el as HTMLElement;
      const lb = h.getAttribute('aria-labelledby');
      if (lb) return lb.split(' ').map((i) => document.getElementById(i)?.textContent ?? '').join(' ').trim();
      if (h.getAttribute('aria-label')) return h.getAttribute('aria-label')!;
      if ((h as HTMLInputElement).labels?.length) return [...(h as HTMLInputElement).labels!].map((l) => l.textContent).join(' ').trim();
      if (h.getAttribute('title')) return h.getAttribute('title')!;
      if (h.tagName === 'IMG') return h.getAttribute('alt') ?? null;
      return (h.textContent ?? '').trim();
    };
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem], [role=treeitem], img, canvas')) {
      if (!vis(el)) continue;
      const n = name(el);
      if (el.tagName === 'IMG' && n === '') continue; // decorative
      if (!n) out.push(`${where} UNNAMED ${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().split(' ')[0]} type=${el.getAttribute('type') ?? ''}`);
    }
    // contrast of visible text
    const parse = (c: string) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = (el: Element | null): { r: number; g: number; b: number } => {
      for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0.9) return c; }
      return parse(getComputedStyle(document.body).backgroundColor);
    };
    const seen = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const el = t.parentElement!;
      if (!t.textContent!.trim() || !vis(el) || el.closest('[aria-hidden=true]')) continue;
      const s = getComputedStyle(el);
      const fg = parse(s.color); const bg = bgOf(el);
      if (s.opacity !== '1' && Number(s.opacity) < 1) fg.a *= Number(s.opacity);
      const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      const L1 = lum(mix), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const key = `${s.color}|${JSON.stringify(bg)}|${size}`;
      if (ratio < need && !seen.has(key)) { seen.add(key); out.push(`${where} CONTRAST ${ratio.toFixed(2)}<${need} "${t.textContent!.trim().slice(0, 30)}" ${s.color} on rgb(${bg.r},${bg.g},${bg.b}) ${size}px .${el.className.toString().split(' ')[0]}`); }
    }
    return out;
  }, where);

async function focusRing(p: Page, where: string, tabs = 30) {
  const out: string[] = [];
  await p.mouse.click(2, 300);
  for (let i = 0; i < tabs; i++) {
    await p.keyboard.press('Tab');
    const r = await p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
      return { ring, desc: `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0]} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 25)}"` };
    });
    if (r && !r.ring) out.push(`${where} NO-FOCUS-RING ${r.desc}`);
  }
  return [...new Set(out)];
}

test('accessibility: names, contrast, focus rings and selection read out', async ({ browser }) => {
  // two colour schemes, five screens and dozens of Tab presses: longer than one ordinary test
  test.setTimeout(120_000);
  const report: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const p = await c.newPage();
    await p.goto('/');
    await p.waitForTimeout(500);
    report.push(...(await audit(p, `${scheme}/files-empty`)), ...(await focusRing(p, `${scheme}/files-empty`, 12)));
    await p.getByRole('button', { name: 'Sample file' }).first().click();
    await p.locator('canvas').waitFor();
    await p.waitForTimeout(800);
    await p.getByRole('treeitem').nth(3).click();
    const picked = (await p.getByRole('treeitem').nth(3).getAttribute('aria-label'))!;
    await expect(p.locator('.canvas-wrap [role=status][aria-live=polite]')).toContainText(picked);
    report.push(...(await audit(p, `${scheme}/editor-design`)), ...(await focusRing(p, `${scheme}/editor-design`, 40)));
    await p.keyboard.press('Escape');
    await p.getByRole('group', { name: 'Editor mode' }).getByRole('button', { name: 'Diagram' }).click();
    await p.waitForTimeout(300);
    report.push(...(await audit(p, `${scheme}/editor-diagram`)));
    await p.keyboard.press('Control+/');
    await p.waitForTimeout(300);
    report.push(...(await audit(p, `${scheme}/quick-actions`)));
    await p.keyboard.press('Escape');
    await p.goto('/');
    await p.waitForTimeout(500);
    report.push(...(await audit(p, `${scheme}/files-list`)));
    await c.close();
  }
  expect(report).toEqual([]);
});
