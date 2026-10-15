import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import '../canvasFonts.ts';
import type { FileMeta } from '../../../shared/schema.ts';
import { ApiError, BROWSER_STORAGE, STORAGE_DOWN, api } from '../../api.ts';
import { Editor } from '../../engine/editor.ts';
import { onImageLoaded, readImageSize, retryFailedImages, useImagesOf } from '../../engine/images.ts';
import { drawChildren } from '../../engine/render.ts';
import { facesUsed } from '../../engine/text.ts';
import { SyncQueue } from '../../engine/sync.ts';
import { navigate } from '../App.tsx';
import { type Theme, loadFonts, useDiagramMode, useEditorRev, useMediaQuery } from '../hooks.ts';
import { ExportFileDialog } from '../ExportFileDialog.tsx';
import { RenameDialog } from './framePanels.tsx';
import { PhoneSheet } from './PhoneSheet.tsx';
import { type ShareFormat, shareView } from '../share.ts';
import { LONG_LINK_CHARS, makeShareLink } from '../shareLink.ts';
import { CanvasView } from './CanvasView.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';
import { TitleBar } from './TitleBar.tsx';
import { VersionHistory } from './VersionHistory.tsx';
import { Presenter } from './Presenter.tsx';
import { FindReplace } from './FindReplace.tsx';
import { QuickActions } from './QuickActions.tsx';
import { type CommentStore, CommentPins, CommentsPanel, useComments } from './Comments.tsx';

/** Properties, or the comment list in comment mode; diagram mode shows only the comment list. */
function RightPanel(props: { editor: Editor; fileName: string; comments: CommentStore; onPresent: () => void; diagram: boolean }) {
  useEditorRev(props.editor, 'tool');
  if (props.editor.tool === 'comment') return <CommentsPanel editor={props.editor} store={props.comments} />;
  return props.diagram ? null : <PropertiesPanel editor={props.editor} fileName={props.fileName} onPresent={props.onPresent} />;
}

/** Where a presentation starts: the frame holding the selection, else the page's starting frame. */
function presentFrom(editor: Editor): string | null {
  const sel = editor.selection[0];
  let cur = sel ? editor.doc.get(sel) : undefined;
  for (let guard = 0; cur?.parentId && guard < 200; guard++) cur = editor.doc.get(cur.parentId);
  return cur?.id ?? editor.currentPage.prototypeStart ?? null;
}
import { DOCK_TOOLS, ToolRail } from './ToolRail.tsx';

/** Screens this narrow show the board view whatever the file's mode. */
const NARROW = '(max-width: 760px)';

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
  const [renaming, setRenaming] = useState(false);
  const [history, setHistory] = useState(false);
  const [finding, setFinding] = useState(false);
  const [palette, setPalette] = useState(false);
  const [diagramChoice, setDiagramModeRaw] = useDiagramMode(fileId);
  // a phone has no room for the panels: it always gets the board view
  const narrow = useMediaQuery(NARROW);
  const diagramMode = diagramChoice || narrow;
  const [sheet, setSheet] = useState(false);
  const setDiagramMode = (on: boolean) => setDiagramModeRaw(on);
  // a tool the dock doesn't offer would be stuck on with no button to see it by (also when a
  // window narrows into the board view)
  useEffect(() => {
    if (diagramMode && !DOCK_TOOLS.has(editor.tool)) editor.setTool('move');
    // on a board, drawn boxes, circles and lines become clean shapes
    editor.recognizeShapes = diagramMode;
  }, [diagramMode, editor]);
  const [presenting, setPresenting] = useState<{ start: string | null } | null>(null);
  const present = () => setPresenting({ start: presentFrom(editor) });
  /** A link that carries this file: through the share sheet on a phone, else copied. */
  const shareLink = async () => {
    try {
      await flushAll();
      const { url, droppedImages } = await makeShareLink(await api.exportFile(fileId));
      const notes = [
        droppedImages ? 'Images are not included.' : '',
        url.length > LONG_LINK_CHARS ? `It is long (${url.length.toLocaleString()} characters), so some chat apps may cut it.` : '',
      ].filter(Boolean);
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      if (nav.share && window.matchMedia('(pointer: coarse)').matches) {
        try {
          await nav.share({ url, title: file?.name });
          if (notes.length) setNotice(notes.join(' '));
          return;
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
        }
      }
      await navigator.clipboard.writeText(url);
      setNotice(['Link copied. Whoever opens it can save their own copy of this file.', ...notes].join(' '));
    } catch (e) {
      setNotice(`Couldn't make a link: ${e instanceof Error ? e.message : 'something went wrong'}`);
    }
  };
  const share = async (format: ShareFormat) => {
    try {
      const done = await shareView(editor, file?.name ?? 'localframe', format);
      if (done === 'empty') setNotice('Nothing to share on this page yet.');
      if (done === 'saved') setNotice(`This browser can't share files, so the ${format.toUpperCase()} was saved to your downloads.`);
    } catch (e) {
      setNotice(`Couldn't share: ${e instanceof Error ? e.message : 'something went wrong'}`);
    }
  };
  const comments = useComments(fileId);
  const { setDraft, setOpen } = comments;
  useEffect(() => {
    editor.onCommentAt = (spot) => {
      setOpen(null);
      setDraft({ ...spot, pageId: editor.doc.currentPage });
    };
    // leaving comment mode or the page closes what was open
    const off = editor.subscribe('tool', () => {
      if (editor.tool !== 'comment') {
        setDraft(null);
        setOpen(null);
      }
    });
    const offPages = editor.subscribe('pages', () => setDraft(null));
    return () => {
      editor.onCommentAt = null;
      off();
      offPages();
    };
  }, [editor, setDraft, setOpen]);
  /** Bumped to load the file again from the server (after restoring a version). */
  const [reloadKey, setReloadKey] = useState(0);

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
        const { file: meta, nodes } = await api.getFile(fileId);
        // wait only for the fonts this file draws with; the others load while you work
        await loadFonts(facesUsed(nodes));
        void loadFonts();
        if (cancelled) return;
        useImagesOf(fileId);
        editor.load(nodes, meta.pages, meta.styles, meta.variables);
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
        // a file that has never been saved here (an import, a sample) gets its thumbnail now
        if (!meta.hasThumbnail && nodes.length) {
          thumbTimer.current = setTimeout(() => {
            const url = makeThumbnail(editor);
            if (url) void api.putThumbnail(fileId, url).catch(() => {});
          }, 800);
        }
      } catch (e) {
        if (cancelled) return;
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? "This file doesn't exist. It may have been deleted."
            : STORAGE_DOWN,
        );
      }
    })();
    const offImages = onImageLoaded(() => editor.emit('view'));
    editor.onRequestImage = () => imageInput.current?.click();
    editor.onRequestRename = () => setRenaming(true);
    editor.onNotice = (text) => setNotice(text);
    editor.onRequestPresent = () => setPresenting({ start: presentFrom(editor) });
    editor.fileId = fileId;
    editor.onPastedImages = (from, ids) => {
      void api
        .copyImages(fileId, from, ids)
        .then(() => {
          retryFailedImages();
          editor.emit('view');
        })
        .catch(() => {});
    };
    return () => {
      editor.onPastedImages = null;
      cancelled = true;
      offImages();
      editor.onRequestImage = null;
      editor.onRequestRename = null;
      editor.onNotice = null;
      editor.onRequestPresent = null;
      queue?.flushOnExit();
      queue?.dispose();
      if (thumbTimer.current) clearTimeout(thumbTimer.current);
    };
  }, [editor, fileId, reloadKey]);

  /** Waits until edits on screen are saved. */
  const flushAll = async () => {
    for (let i = 0; i < 50 && sync?.pending; i++) {
      await sync.flush();
      await new Promise((r) => setTimeout(r, 100));
    }
    if (sync?.pending) throw new Error('Edits are still saving. Try again in a moment.');
  };

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
      if (mod && !e.shiftKey && !e.altKey && (e.code === 'Slash' || e.code === 'KeyK')) {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        setFinding(true);
        return;
      }
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
    const onBlur = () => {
      editor.keyUp({ code: 'Space' });
      editor.keyUp({ code: 'Blur' });
    };
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
    <div className={`editor ${diagramMode ? 'diagram-mode' : ''}`}>
      <TitleBar
        editor={editor}
        file={file}
        saveStatus={saveStatus as SyncQueue['status']}
        saveError={saveError || null}
        theme={theme}
        setTheme={setTheme}
        onExportFile={() => setExporting(true)}
        onShare={(f) => void share(f)}
        onShareLink={BROWSER_STORAGE ? () => void shareLink() : undefined}
        onHistory={() => setHistory(true)}
        onPresent={present}
        onQuickActions={() => setPalette(true)}
        diagramMode={diagramMode}
        onDiagramMode={narrow ? undefined : setDiagramMode}
        onPanels={narrow ? () => setSheet(!sheet) : undefined}
        panelsOpen={sheet}
        onRename={async (name) => {
          const meta = await api.updateFile(fileId, { name });
          setFile(meta);
          document.title = `${meta.name} · localframe`;
        }}
      />
      {!diagramMode && <ToolRail editor={editor} />}
      {!diagramMode && <LeftPanel editor={editor} />}
      <CanvasView
        editor={editor}
        diagram={diagramMode}
        onReady={onCanvasReady}
        onDropFiles={(files, at) => void placeImages(files, at)}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
      >
        <CommentPins editor={editor} store={comments} />
        {diagramMode && <ToolRail editor={editor} dock />}
      </CanvasView>
      {narrow ? (
        sheet && <PhoneSheet editor={editor} fileName={file.name} comments={comments} onPresent={present} onClose={() => setSheet(false)} />
      ) : (
        <RightPanel editor={editor} fileName={file.name} comments={comments} onPresent={present} diagram={diagramMode} />
      )}
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
      {renaming && <RenameDialog editor={editor} onClose={() => setRenaming(false)} />}
      {exporting && (
        <ExportFileDialog
          fileId={fileId}
          fileName={file.name}
          onClose={() => setExporting(false)}
          beforeExport={flushAll}
        />
      )}
      {palette && (
        <QuickActions
          editor={editor}
          onClose={() => setPalette(false)}
          screen={{
            exportFile: () => setExporting(true),
            present,
            history: () => setHistory(true),
            find: () => setFinding(true),
            placeImage: () => imageInput.current?.click(),
            rename: () => setRenaming(true),
            diagramMode,
            setDiagramMode: narrow ? undefined : setDiagramMode,
            share: (f) => void share(f),
            shareLink: BROWSER_STORAGE ? () => void shareLink() : undefined,
          }}
        />
      )}
      {finding && <FindReplace editor={editor} onClose={() => setFinding(false)} />}
      {presenting && <Presenter editor={editor} startId={presenting.start} onClose={() => setPresenting(null)} />}
      {history && (
        <VersionHistory
          fileId={fileId}
          onClose={() => setHistory(false)}
          beforeSave={flushAll}
          onRestore={async (vid) => {
            await flushAll();
            await api.restoreVersion(fileId, vid);
            setHistory(false);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}
