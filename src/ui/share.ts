import type { Editor } from '../engine/editor.ts';
import { exportImage, exportPdf } from '../engine/export.ts';
import { downloadBlob, safeFileName } from './download.ts';

export type ShareFormat = 'png' | 'pdf';

/**
 * What gets shared: the selection, or else the whole page. A PDF of a page gets one page per
 * frame when the page has frames.
 */
function targets(editor: Editor, format: ShareFormat) {
  const background = editor.background;
  const visible = (id: string) => editor.doc.get(id)?.visible && !editor.doc.get(id)?.slice;
  if (editor.selection.length) return { what: 'selection', list: [{ ids: editor.selection.filter(visible), background }] };
  const all = editor.doc.children(null).filter(visible);
  const frames = editor.topFrames().filter((f) => f.visible);
  if (format === 'pdf' && frames.length > 1) return { what: 'page', list: frames.map((f) => ({ ids: [f.id], background })) };
  return { what: 'page', list: [{ ids: all, background }] };
}

/**
 * Shares the selection or the page as a PNG or PDF through the device's share sheet (messages,
 * mail, files) where there is one, otherwise saves it. Nothing goes anywhere the person doesn't pick.
 */
export async function shareView(editor: Editor, fileName: string, format: ShareFormat): Promise<'shared' | 'saved' | 'cancelled' | 'empty'> {
  const { list } = targets(editor, format);
  if (!list.some((t) => t.ids.length)) return 'empty';
  const base = safeFileName(fileName, 'localframe');
  const blob =
    format === 'png'
      ? await exportImage(editor.doc, list[0], 2, 'png')
      : await exportPdf(
          editor.doc,
          list.filter((t) => t.ids.length),
          2,
          fileName,
        );
  const file = new File([blob], `${base}.${format}`, { type: format === 'png' ? 'image/png' : 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e) {
      // closing the share sheet isn't an error
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      // a slow export can outlast the tap that allowed sharing: save the file instead
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) throw e;
    }
  }
  downloadBlob(blob, file.name);
  return 'saved';
}
