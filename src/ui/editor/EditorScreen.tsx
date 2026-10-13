import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { FileMeta } from '../../../shared/schema.ts';
import { ApiError, api } from '../../api.ts';
import { Editor } from '../../engine/editor.ts';
import { onImageLoaded, readImageSize, useImagesOf } from '../../engine/images.ts';
import { drawChildren } from '../../engine/render.ts';
import { SyncQueue } from '../../engine/sync.ts';
import { navigate } from '../App.tsx';
import { type Theme, loadFonts } from '../hooks.ts';
import { ExportFileDialog } from '../ExportFileDialog.tsx';
import { CanvasView } from './CanvasView.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';
import { TitleBar } from './TitleBar.tsx';
import { ToolRail } from './ToolRail.tsx';

const THUMB_W = 480;
const THUMB_H = 300;

function makeThumbnail(editor: Editor): string | null {
  const bounds = editor.contentBounds();
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = editor.background;
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    const pad = 24;
    const s = Math.min((THUMB_W - pad * 2) / bounds.width, (THUMB_H - pad * 2) / bounds.height, 2);
    const ox = (THUMB_W - bounds.width * s) / 2 - bounds.x * s;
    const oy = (THUMB_H - bounds.height * s) / 2 - bounds.y * s;
    ctx.setTransform(s, 0, 0, s, ox, oy);
    drawChildren(ctx, editor.doc, null);
  }
  return canvas.toDataURL('image/png');
}

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

const VIEW_KEY = (id: string) => `localframe.view.${id}`;
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function EditorScreen({ fileId, theme, setTheme }: { fileId: string; theme: Theme; setTheme: (t: Theme) => void }) {
  const editor = useMemo(() => new Editor(), []);
  const [file, setFile] = useState<FileMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncQueue | null>(null);
  const thumbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  /** Uploads image files and places them on the canvas (at a point, or in the middle of the view). */
  const placeImages = async (files: File[], at?: { x: number; y: number }) => {
    const images = files.filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
    if (images.length === 0) {
      if (files.length) setNotice('Only PNG, JPEG, WebP and GIF images can be placed.');
      return;
    }
    let offset = 0;
    for (const f of images) {
      if (f.size > MAX_IMAGE_BYTES) {
        setNotice(`“${f.name}” is larger than 20 MB, which is the image limit.`);
        continue;
      }
      try {
        const [{ id }, size] = await Promise.all([api.uploadImage(fileId, f), readImageSize(f)]);
        const p = at ? { x: at.x + offset, y: at.y + offset } : undefined;
        editor.insertImage(id, size, f.name || 'Image', p);
        offset += 24;
      } catch (e) {
        setNotice(`Couldn't place “${f.name}”: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    }
  };

  // load the file
  useEffect(() => {
    let cancelled = false;
    let queue: SyncQueue | null = null;
    (async () => {
      try {
        const [{ file: meta, nodes }] = await Promise.all([api.getFile(fileId), loadFonts()]);
        if (cancelled) return;
        useImagesOf(fileId);
        editor.load(nodes, meta.pages);
        setFile(meta);
        document.title = `${meta.name} · localframe`;
        queue = new SyncQueue(fileId, meta.version, editor, () => {
          if (thumbTimer.current) clearTimeout(thumbTimer.current);
          thumbTimer.current = setTimeout(() => {
            const url = makeThumbnail(editor);
            if (url) void api.putThumbnail(fileId, url).catch(() => {});
          }, 1500);
        });
        setSync(queue);
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? "This file doesn't exist. It may have been deleted."
            : "Couldn't reach the local server. Start it with npm run dev (or npm start) and reload.",
        );
      }
    })();
    const offImages = onImageLoaded(() => editor.emit('view'));
    editor.onRequestImage = () => imageInput.current?.click();
    return () => {
      cancelled = true;
      offImages();
      editor.onRequestImage = null;
      queue?.flushOnExit();
      queue?.dispose();
      if (thumbTimer.current) clearTimeout(thumbTimer.current);
    };
  }, [editor, fileId]);

  // first view: restore the last viewport, or fit the content
  const placed = useRef(false);
  const onCanvasReady = () => {
    if (placed.current || !file) return;
    placed.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_KEY(fileId)) ?? 'null');
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.zoom === 'number') {
        editor.setViewport(saved);
        return;
      }
    } catch {
      /* ignore */
    }
    if (editor.doc.size > 0) editor.zoomToFit();
    else editor.setViewport({ x: editor.viewSize.width / 2 - 400, y: editor.viewSize.height / 2 - 300, zoom: 1 });
  };

  useEffect(() => {
    if (!file) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    return editor.subscribe('view', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        try {
          localStorage.setItem(VIEW_KEY(fileId), JSON.stringify(editor.viewport));
        } catch {
          /* ignore */
        }
      }, 400);
    });
  }, [editor, file, fileId]);

  // keyboard and clipboard
  useEffect(() => {
    if (!file) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV')) return; // handled by clipboard events
      if (mod && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        setExporting(true);
        return;
      }
      if (editor.keyDown({ code: e.code, key: e.key, shift: e.shiftKey, alt: e.altKey, mod, repeat: e.repeat })) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => editor.keyUp({ code: e.code });
    const onCopy = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || editor.editingText) return;
      const text = editor.copyToText();
      if (text && e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || editor.editingText) return;
      const text = editor.cutToText();
      if (text && e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || editor.editingText) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void placeImages(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text) {
        editor.pasteText(text);
        e.preventDefault();
      }
    };
    const onBlur = () => editor.keyUp({ code: 'Space' });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [editor, file]);

  // don't lose edits when the tab closes
  useEffect(() => {
    if (!sync) return;
    const onPageHide = () => sync.flushOnExit();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (sync.pending && sync.status !== 'saving') e.preventDefault();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [sync]);

  const status = useSyncExternalStore(
    (fn) => (sync ? sync.subscribe(fn) : () => {}),
    () => (sync ? `${sync.status}|${sync.error ?? ''}` : 'saved|'),
  );

  if (loadError) {
    return (
      <div className="center-message">
        <p>{loadError}</p>
        <button type="button" className="btn secondary" onClick={() => navigate('#/')}>
          Back to files
        </button>
      </div>
    );
  }
  if (!file) return <div className="center-message" aria-busy="true">Opening file…</div>;

  const [saveStatus, saveError] = status.split('|');

  return (
    <div className="editor">
      <TitleBar
        editor={editor}
        file={file}
        saveStatus={saveStatus as SyncQueue['status']}
        saveError={saveError || null}
        theme={theme}
        setTheme={setTheme}
        onExportFile={() => setExporting(true)}
        onRename={async (name) => {
          const meta = await api.updateFile(fileId, { name });
          setFile(meta);
          document.title = `${meta.name} · localframe`;
        }}
      />
      <ToolRail editor={editor} />
      <LeftPanel editor={editor} />
      <CanvasView
        editor={editor}
        onReady={onCanvasReady}
        onDropFiles={(files, at) => void placeImages(files, at)}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
      />
      <PropertiesPanel editor={editor} fileName={file.name} />
      <input
        ref={imageInput}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        aria-label="Place image"
        onChange={(e) => {
          void placeImages([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {exporting && (
        <ExportFileDialog
          fileId={fileId}
          fileName={file.name}
          onClose={() => setExporting(false)}
          beforeExport={async () => {
            // export what is on screen: wait for pending saves
            for (let i = 0; i < 50 && sync?.pending; i++) {
              await sync.flush();
              await new Promise((r) => setTimeout(r, 100));
            }
          }}
        />
      )}
    </div>
  );
}
