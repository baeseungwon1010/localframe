import type { SceneNode } from '../../shared/schema.ts';
import { api } from '../api.ts';
import { SceneDoc } from '../engine/doc.ts';
import { type ExportTarget, exportBounds, exportImage, exportPdf, exportSvg } from '../engine/export.ts';
import { useImagesOf } from '../engine/images.ts';
import { buildZip, uniqueName } from '../engine/zip.ts';
import { safeFileName } from './download.ts';
import { loadFonts } from './hooks.ts';
import { printSvgPages } from './print.ts';
import { exportLayers } from './layerExport.ts';

export type FileExportFormat = 'localframe' | 'settings' | 'pdf' | 'print' | 'png' | 'jpg' | 'webp' | 'svg';

export const FILE_EXPORT_FORMATS: { value: FileExportFormat; label: string; detail: string }[] = [
  { value: 'localframe', label: 'localframe file (.localframe.json)', detail: 'Everything, editable. Import it on any machine.' },
  { value: 'settings', label: "Layers' export settings", detail: 'Every layer with saved export settings, in each of its formats and sizes. A ZIP with a folder per page.' },
  { value: 'pdf', label: 'PDF (.pdf)', detail: 'Every frame becomes a page, in page order. Layers outside frames get a page of their own.' },
  { value: 'print', label: 'Vector PDF (print)', detail: 'Opens the print dialog; choose Save as PDF. Text and shapes stay sharp at any zoom.' },
  { value: 'png', label: 'PNG images', detail: 'One image per frame. Several frames come in a .zip.' },
  { value: 'jpg', label: 'JPG images', detail: 'Smaller files, no transparency. Several frames come in a .zip.' },
  { value: 'webp', label: 'WebP images', detail: 'Small files with transparency. Several frames come in a .zip.' },
  { value: 'svg', label: 'SVG files', detail: 'Vector, with images and fonts embedded. Several frames come in a .zip.' },
];

type Item = { page: string; name: string; target: ExportTarget };

/** What gets exported per page: each top-level frame, or the whole page if it has no frames. */
function collectItems(doc: SceneDoc, pages: { id: string; name: string; background: string }[]): Item[] {
  const items: Item[] = [];
  for (const page of pages) {
    // frames inside sections are exported like frames on the page; an empty section is skipped
    const top = doc
      .pageChildren(page.id)
      .flatMap((id) => (doc.get(id)!.section ? doc.children(id) : [id]))
      .map((id) => doc.get(id)!)
      .filter((n) => n.visible);
    if (top.length === 0) continue;
    const isFrame = (n: SceneNode) => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE';
    for (const f of top.filter(isFrame)) items.push({ page: page.name, name: f.name, target: { ids: [f.id], background: null } });
    // layers that sit on the page outside any frame are exported together, on the page colour
    const loose = top.filter((n) => !isFrame(n));
    if (loose.length) {
      const name = loose.length === top.length ? page.name : `${page.name} (other layers)`;
      items.push({ page: page.name, name, target: { ids: loose.map((n) => n.id), background: page.background } });
    }
  }
  return items;
}

/** Every frame as an SVG page, sent to the browser's print dialog. */
export async function printWholeFile(fileId: string): Promise<void> {
  const [{ file, nodes }] = await Promise.all([api.getFile(fileId), loadFonts()]);
  const doc = new SceneDoc();
  doc.load(nodes, file.pages[0].id);
  const previous = useImagesOf(fileId);
  try {
    const items = collectItems(doc, file.pages);
    if (items.length === 0) throw new Error('This file is empty');
    const pages = [];
    for (const it of items) {
      const target = { ...it.target, background: it.target.background ?? pageBackground(file.pages, it.page) };
      const b = exportBounds(doc, target.ids);
      if (b) pages.push({ svg: await exportSvg(doc, target), width: b.width, height: b.height });
    }
    await printSvgPages(pages, file.name);
  } finally {
    useImagesOf(previous);
  }
}

/** Exports a whole file. Returns the file to download. */
export async function exportWholeFile(fileId: string, format: FileExportFormat, scale: number): Promise<{ blob: Blob; filename: string }> {
  if (format === 'print') throw new Error('Vector PDF goes through the print dialog');
  if (format === 'localframe') {
    const data = await api.exportFile(fileId);
    return {
      blob: new Blob([JSON.stringify(data)], { type: 'application/json' }),
      filename: `${safeFileName(data.name, 'file')}.localframe.json`,
    };
  }
  const [{ file, nodes }] = await Promise.all([api.getFile(fileId), loadFonts()]);
  const doc = new SceneDoc();
  doc.load(nodes, file.pages[0].id);
  const base = safeFileName(file.name, 'file');
  const previous = useImagesOf(fileId);
  try {
    if (format === 'settings') {
      const nodes = [...doc.all()].filter((n) => n.exportSettings?.length && doc.isEffectivelyVisible(n.id));
      const pageOf = (n: SceneNode) => file.pages.find((p) => p.id === doc.pageOf(n.id));
      const out = await exportLayers(
        doc,
        nodes,
        (n) => (n.parentId === null && !n.fills.length ? (pageOf(n)?.background ?? null) : null),
        `${base}-export`,
        file.pages.length > 1 ? (n) => safeFileName(pageOf(n)?.name ?? 'Page', 'Page') : undefined,
      );
      if (!out) throw new Error('No layer in this file has export settings. Add them in the Export section.');
      return out;
    }
    const items = collectItems(doc, file.pages);
    if (items.length === 0) throw new Error('This file is empty');
    if (format === 'pdf') {
      // a page without its own fill gets the page colour behind it
      const targets = items.map((it) => ({ ...it.target, background: it.target.background ?? pageBackground(file.pages, it.page) }));
      return { blob: await exportPdf(doc, targets, scale, file.name), filename: `${base}.pdf` };
    }
    const ext = format;
    const render = async (t: ExportTarget): Promise<Blob> =>
      format === 'svg' ? new Blob([await exportSvg(doc, t)], { type: 'image/svg+xml' }) : exportImage(doc, t, scale, format);
    if (items.length === 1) {
      return { blob: await render(items[0].target), filename: `${safeFileName(items[0].name, base)}.${ext}` };
    }
    const used = new Set<string>();
    const multiPage = new Set(items.map((i) => i.page)).size > 1;
    const entries = [];
    for (const it of items) {
      const name = `${multiPage ? `${safeFileName(it.page, 'Page')}/` : ''}${safeFileName(it.name, 'Frame')}.${ext}`;
      entries.push({ name: uniqueName(name, used), data: new Uint8Array(await (await render(it.target)).arrayBuffer()) });
    }
    return { blob: buildZip(entries), filename: `${base}-${ext}.zip` };
  } finally {
    useImagesOf(previous);
  }
}

function pageBackground(pages: { name: string; background: string }[], name: string) {
  return pages.find((p) => p.name === name)?.background ?? '#FFFFFF';
}
