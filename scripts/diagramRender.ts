// Pictures of built diagrams, for whoever wrote the spec to look at: the CLI (scripts/diagram.ts)
// and the MCP server (scripts/mcp.ts). Drawn as SVG by the engine, turned into a PNG by a browser:
// Playwright's Chromium if it's installed, else Chrome or Edge on the machine.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright-core';
import type { Built } from '../src/diagram/build.ts';
import { VIEW_WIDTH } from '../src/diagram/lint.ts';
import { svgMarkup } from '../src/engine/export.ts';

const FACES = ['inter/400', 'inter/500', 'inter/600', 'inter/700', 'noto-sans-kr/400', 'noto-sans-kr/500', 'noto-sans-kr/600', 'noto-sans-kr/700'];

/** The first of these folders that holds the fonts' packages (inter/, noto-sans-kr/). */
export function findFonts(...dirs: string[]): string | null {
  return dirs.find((d) => existsSync(join(d, 'inter/400.css'))) ?? null;
}

export function diagramSvg(built: Built): string {
  return svgMarkup(built.doc, { ids: built.doc.children(null), background: built.file.background }).svg;
}

export class Renderer {
  private browser: Promise<Browser> | null = null;
  private readonly fonts: string;

  /** `fonts`: a folder with the @fontsource packages the diagrams use (inter/, noto-sans-kr/). */
  constructor(fonts: string | null) {
    this.fonts = fonts ? FACES.map((f) => `<link rel="stylesheet" href="${pathToFileURL(join(fonts, `${f}.css`))}">`).join('') : '';
  }

  private launch(): Promise<Browser> {
    this.browser ??= (async () => {
      const { chromium } = await import('playwright-core');
      const tried: string[] = [];
      for (const channel of [undefined, 'chrome', 'msedge']) {
        try {
          return await chromium.launch(channel ? { channel } : {});
        } catch (e) {
          tried.push(`${channel ?? 'Playwright Chromium'}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
        }
      }
      throw new Error(`no browser to draw the picture with (${tried.join('; ')})`);
    })();
    this.browser.catch(() => (this.browser = null));
    return this.browser;
  }

  /**
   * A PNG of the SVG, `zoom` times its size (1 for the CLI; the size it's seen at in a
   * 1600px-wide view for an agent, so it sees what a reader would).
   */
  async png(svg: string, background: string, zoom = 1): Promise<Buffer> {
    const browser = await this.launch();
    const dir = mkdtempSync(join(tmpdir(), 'localframe-'));
    const html = join(dir, 'render.html');
    // a page on disk, so it may load the fonts from disk
    writeFileSync(html, `<!doctype html><meta charset="utf-8">${this.fonts}<style>body{margin:0}div{display:inline-block;padding:40px;background:${background};zoom:${zoom}}</style><div>${svg}</div>`);
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    try {
      await page.goto(pathToFileURL(html).href);
      await page.evaluate(() => document.fonts.ready);
      return await page.locator('div').first().screenshot();
    } finally {
      await page.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** How much to shrink a diagram this wide to see it as a reader would. */
  static viewZoom(width: number): number {
    return Math.min(1, VIEW_WIDTH / width);
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close();
  }
}
