import type { ExportedFile } from '../../shared/schema.ts';
import { SceneDoc } from '../engine/doc.ts';
import { renderCanvas } from '../engine/export.ts';
import './canvasFonts.ts';
import { loadFonts } from './hooks.ts';

/** A picture of a shared file's first page (images show as their placeholders: links carry none). */
export async function previewImage(file: ExportedFile): Promise<string | null> {
  const page = file.pages?.[0];
  const doc = new SceneDoc();
  doc.load(file.nodes, page?.id ?? 'page-1');
  if (page) doc.setCurrentPage(page.id);
  const ids = doc.children(null).filter((id) => doc.get(id)!.visible && !doc.get(id)!.slice);
  if (!ids.length) return null;
  await loadFonts();
  const scale = 1;
  const { canvas } = await renderCanvas(doc, { ids, background: page?.background ?? file.background }, scale);
  // keep the picture a sensible size
  const max = 1600;
  if (canvas.width > max || canvas.height > max) {
    const k = max / Math.max(canvas.width, canvas.height);
    const small = document.createElement('canvas');
    small.width = Math.round(canvas.width * k);
    small.height = Math.round(canvas.height * k);
    small.getContext('2d')!.drawImage(canvas, 0, 0, small.width, small.height);
    return small.toDataURL('image/png');
  }
  return canvas.toDataURL('image/png');
}
