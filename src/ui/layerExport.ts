import type { SceneNode } from '../../shared/schema.ts';
import type { SceneDoc } from '../engine/doc.ts';
import { exportImage, exportPdf, exportSvg, exportTargetFor } from '../engine/export.ts';
import { buildZip, uniqueName } from '../engine/zip.ts';
import { safeFileName } from './download.ts';

export type ExportSetting = NonNullable<SceneNode['exportSettings']>[number];

/** The file for one export setting of a layer. `background` goes behind layers without their own fill. */
export async function exportSetting(
  doc: SceneDoc,
  node: SceneNode,
  s: ExportSetting,
  background: string | null,
  pageBackground = '#FFFFFF',
): Promise<{ blob: Blob; filename: string }> {
  const target = exportTargetFor(doc, node, background, pageBackground);
  const name = `${safeFileName(node.name, 'Layer')}${s.suffix}`;
  if (s.format === 'svg') return { blob: new Blob([await exportSvg(doc, target)], { type: 'image/svg+xml' }), filename: `${name}.svg` };
  if (s.format === 'pdf') return { blob: await exportPdf(doc, [{ ...target, background: target.background ?? pageBackground }], s.scale, node.name), filename: `${name}.pdf` };
  return { blob: await exportImage(doc, target, s.scale, s.format), filename: `${name}.${s.format}` };
}

/** Every export setting of every given layer: one file, or a ZIP when there are several. */
export async function exportLayers(
  doc: SceneDoc,
  nodes: SceneNode[],
  background: (n: SceneNode) => string | null,
  zipName: string,
  folder?: (n: SceneNode) => string,
  pageBackground: (n: SceneNode) => string = () => '#FFFFFF',
): Promise<{ blob: Blob; filename: string } | null> {
  const files: { blob: Blob; filename: string }[] = [];
  for (const n of nodes) {
    for (const s of n.exportSettings ?? []) {
      const f = await exportSetting(doc, n, s, background(n), pageBackground(n));
      files.push(folder ? { ...f, filename: `${folder(n)}/${f.filename}` } : f);
    }
  }
  if (files.length === 0) return null;
  if (files.length === 1) return { ...files[0], filename: files[0].filename.split('/').pop()! };
  const used = new Set<string>();
  const entries = [];
  for (const f of files) entries.push({ name: uniqueName(f.filename, used), data: new Uint8Array(await f.blob.arrayBuffer()) });
  return { blob: buildZip(entries), filename: `${safeFileName(zipName, 'export')}.zip` };
}
