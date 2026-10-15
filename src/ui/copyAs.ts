import type { Editor } from '../engine/editor.ts';
import { exportImage, exportSvg } from '../engine/export.ts';

export type CopyFormat = 'png' | 'svg';

/**
 * Copies the selection as a picture (PNG, transparent, at 2x) or as SVG text, to paste into chats,
 * documents and other design tools. The clipboard is handed a promise, so the work can take a
 * moment without losing the click that allowed it (Safari insists on that).
 */
export async function copyAs(editor: Editor, format: CopyFormat): Promise<'copied' | 'empty' | 'unsupported'> {
  const ids = editor.selection.filter((id) => editor.doc.get(id)?.visible);
  if (!ids.length) return 'empty';
  const target = { ids, background: null };
  const clipboard = navigator.clipboard as Clipboard | undefined;
  const canWrite = typeof ClipboardItem !== 'undefined' && !!clipboard?.write;
  if (format === 'png') {
    if (!canWrite) return 'unsupported';
    await clipboard!.write([new ClipboardItem({ 'image/png': exportImage(editor.doc, target, 2, 'png') })]);
    return 'copied';
  }
  const svg = exportSvg(editor.doc, target, { embedFonts: false });
  if (canWrite) await clipboard!.write([new ClipboardItem({ 'text/plain': svg.then((s) => new Blob([s], { type: 'text/plain' })) })]);
  else if (clipboard?.writeText) await clipboard.writeText(await svg);
  else return 'unsupported';
  return 'copied';
}
