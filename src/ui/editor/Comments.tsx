import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Comment } from '../../../shared/schema.ts';
import { api } from '../../api.ts';
import type { CommentSpot, Editor } from '../../engine/editor.ts';
import { hitDeepest } from '../../engine/hit.ts';
import { type Point, apply, invert, round2 } from '../../engine/math.ts';
import { useEditorRev } from '../hooks.ts';
import { t } from '../i18n.ts';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export type CommentStore = ReturnType<typeof useComments>;

/** The file's comments, loaded once and kept in step with the server. */
export function useComments(fileId: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<(CommentSpot & { pageId: string }) | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listComments(fileId)
      .then((c) => live && setComments(c))
      .catch(() => live && setError("Couldn't load comments."));
    return () => {
      live = false;
    };
  }, [fileId]);

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      return null;
    }
  }, []);

  const add = useCallback(
    async (c: Parameters<typeof api.addComment>[1]) => {
      const made = await guard(() => api.addComment(fileId, c));
      if (made) setComments((list) => [...list, made]);
      return made;
    },
    [fileId, guard],
  );

  const update = useCallback(
    async (id: string, patch: Parameters<typeof api.updateComment>[2]) => {
      const next = await guard(() => api.updateComment(fileId, id, patch));
      if (!next) return;
      // moving a thread moves its replies
      setComments((list) =>
        list.map((c) =>
          c.id === id ? next : c.parentId === id ? { ...c, x: next.x, y: next.y, nodeId: next.nodeId, offset: next.offset } : c,
        ),
      );
    },
    [fileId, guard],
  );

  const remove = useCallback(
    async (id: string) => {
      const ok = await guard(() => api.deleteComment(fileId, id).then(() => true));
      if (ok) {
        setComments((list) => list.filter((c) => c.id !== id && c.parentId !== id));
        setOpen((o) => (o === id ? null : o));
      }
    },
    [fileId, guard],
  );

  return { comments, error, setError, open, setOpen, draft, setDraft, add, update, remove };
}

/** Where a pin sits on the page: inside its layer while the layer is there. */
export function pinPoint(editor: Editor, c: Comment): Point {
  const n = c.nodeId ? editor.doc.get(c.nodeId) : undefined;
  if (n && c.offset && editor.doc.pageOf(n.id) === c.pageId) return apply(editor.doc.world(n.id), c.offset);
  return { x: c.x, y: c.y };
}

/** Threads (top-level comments) on the current page, oldest first, with their number. */
function useThreads(editor: Editor, store: CommentStore) {
  const page = editor.doc.currentPage;
  return useMemo(() => {
    const roots = store.comments.filter((c) => !c.parentId);
    const number = new Map(roots.map((c, i) => [c.id, i + 1]));
    return roots
      .filter((c) => c.pageId === page)
      .map((c) => ({ root: c, number: number.get(c.id)!, replies: store.comments.filter((r) => r.parentId === c.id) }));
  }, [store.comments, page]);
}

/** Comment pins over the canvas, the thread being read and the comment being written. */
export function CommentPins({ editor, store }: { editor: Editor; store: CommentStore }) {
  useEditorRev(editor, 'view', 'doc', 'pages', 'tool');
  const threads = useThreads(editor, store);
  if (editor.tool !== 'comment') return null;
  const openThread = threads.find((th) => th.root.id === store.open);
  const size = editor.viewSize;
  const popoverAt = (p: Point) => ({
    left: Math.max(8, Math.min(p.x + 20, size.width - 300)),
    top: Math.max(8, Math.min(p.y - 12, size.height - 260)),
  });

  return (
    <div className="comment-layer">
      {threads.map((th) => (
        <Pin key={th.root.id} editor={editor} store={store} thread={th.root} number={th.number} open={store.open === th.root.id} />
      ))}
      {store.draft && (
        <>
          <span className="comment-pin draft" style={pinStyle(editor.toScreen(store.draft))} aria-hidden="true" />
          <div className="comment-popover" style={popoverAt(editor.toScreen(store.draft))}>
            <Composer
              label={t('Add a comment')}
              action={t('Post')}
              onCancel={() => store.setDraft(null)}
              onSubmit={async (body) => {
                const d = store.draft!;
                const made = await store.add({ pageId: d.pageId, x: d.x, y: d.y, nodeId: d.nodeId, offset: d.offset, body });
                if (made) {
                  store.setDraft(null);
                  store.setOpen(made.id);
                }
              }}
            />
          </div>
        </>
      )}
      {openThread && (
        <div className="comment-popover" style={popoverAt(editor.toScreen(pinPoint(editor, openThread.root)))} role="dialog" aria-label={t('Comment {n}', { n: openThread.number })}>
          <Thread store={store} root={openThread.root} replies={openThread.replies} number={openThread.number} />
        </div>
      )}
      {store.error && (
        <div className="toast" role="alert">
          <span>{t(store.error)}</span>
          <button type="button" className="mini-btn" aria-label={t('Dismiss')} onClick={() => store.setError(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

const pinStyle = (p: Point) => ({ left: p.x, top: p.y });

/** A pin: click to open its thread, drag to move it (onto another layer, or onto the page). */
function Pin(props: { editor: Editor; store: CommentStore; thread: Comment; number: number; open: boolean }) {
  const { editor, store, thread } = props;
  const [drag, setDrag] = useState<Point | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const at = drag ?? editor.toScreen(pinPoint(editor, thread));

  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <button
      type="button"
      className={`comment-pin ${thread.resolved ? 'resolved' : ''} ${props.open ? 'on' : ''}`}
      style={pinStyle(at)}
      aria-label={thread.resolved ? t('Comment {n}, resolved: {body}', { n: props.number, body: thread.body }) : t('Comment {n}: {body}', { n: props.number, body: thread.body })}
      aria-expanded={props.open}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 4) return;
        s.moved = true;
        setDrag(local(e));
      }}
      onPointerUp={(e) => {
        const s = start.current;
        start.current = null;
        if (!s?.moved) {
          store.setDraft(null);
          store.setOpen(props.open ? null : thread.id);
          return;
        }
        const screen = local(e);
        setDrag(null);
        const p = editor.toWorld(screen.x, screen.y);
        const id = hitDeepest(editor.doc, p, 4 / editor.viewport.zoom);
        const offset = id ? apply(invert(editor.doc.world(id)), p) : null;
        void store.update(thread.id, {
          x: round2(p.x),
          y: round2(p.y),
          nodeId: id,
          offset: offset && { x: round2(offset.x), y: round2(offset.y) },
        });
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      {props.number}
    </button>
  );
}

function Thread(props: { store: CommentStore; root: Comment; replies: Comment[]; number: number }) {
  const { store, root } = props;
  return (
    <div className="comment-thread">
      <div className="comment-thread-head">
        <span className="comment-number">{t('Comment {n}', { n: props.number })}</span>
        <button
          type="button"
          className="mini-btn"
          aria-label={root.resolved ? t('Reopen') : t('Resolve')}
          title={root.resolved ? t('Reopen') : t('Resolve')}
          aria-pressed={root.resolved}
          onClick={() => void store.update(root.id, { resolved: !root.resolved })}
        >
          <Check size={14} strokeWidth={1.5} />
        </button>
        <button type="button" className="mini-btn" aria-label={t('Close')} onClick={() => store.setOpen(null)}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <ol className="comment-messages">
        {[root, ...props.replies].map((c) => (
          <Message key={c.id} store={store} comment={c} />
        ))}
      </ol>
      <Composer key={root.id} label={t('Reply')} action={t('Reply')} onSubmit={async (body) => void (await store.add({ parentId: root.id, pageId: root.pageId, x: root.x, y: root.y, body }))} />
    </div>
  );
}

function Message({ store, comment }: { store: CommentStore; comment: Comment }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (editing) {
    return (
      <li className="comment-message">
        <Composer
          label={t('Edit comment')}
          action={t('Save')}
          initial={comment.body}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await store.update(comment.id, { body });
            setEditing(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className="comment-message">
      <p className="comment-body">{comment.body}</p>
      <div className="comment-meta">
        <span className="file-time">{when.format(new Date(comment.createdAt))}</span>
        {confirm ? (
          <>
            <button type="button" className="link-btn" onClick={() => setConfirm(false)}>
              {t('Keep')}
            </button>
            <button type="button" className="link-btn danger" onClick={() => void store.remove(comment.id)}>
              {comment.parentId ? t('Delete reply') : t('Delete thread')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>
              {t('Edit')}
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirm(true)}>
              {t('Delete')}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** A text box that posts on Enter (Shift+Enter for a new line) and cancels on Escape. */
function Composer(props: { label: string; action: string; initial?: string; onSubmit: (body: string) => Promise<void>; onCancel?: () => void }) {
  const [value, setValue] = useState(props.initial ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await props.onSubmit(body);
      setValue('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        className="comment-input"
        aria-label={props.label}
        placeholder={props.label}
        value={value}
        maxLength={5000}
        rows={2}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
          if (e.key === 'Escape') props.onCancel?.();
        }}
      />
      <div className="comment-composer-actions">
        {props.onCancel && (
          <button type="button" className="mini-btn wide" onClick={props.onCancel}>
            {t('Cancel')}
          </button>
        )}
        <button type="submit" className="btn primary small" disabled={busy || !value.trim()}>
          {props.action}
        </button>
      </div>
    </form>
  );
}

/** Right-hand panel in comment mode: every thread on the page. */
export function CommentsPanel({ editor, store }: { editor: Editor; store: CommentStore }) {
  useEditorRev(editor, 'pages', 'doc');
  const [showResolved, setShowResolved] = useState(false);
  const threads = useThreads(editor, store).filter((th) => showResolved || !th.root.resolved);
  return (
    <aside className="props" aria-label={t('Comments')}>
      <div className="panel-title">{t('Comments')}</div>
      <label className="check-row comment-filter">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
        {t('Show resolved')}
      </label>
      {threads.length === 0 ? (
        <p className="panel-empty">{t('Click anywhere on the canvas to leave a comment. Comments on a layer move with it.')}</p>
      ) : (
        <ul className="comment-list">
          {threads.map((th) => (
            <li key={th.root.id}>
              <button
                type="button"
                className={`comment-item ${store.open === th.root.id ? 'on' : ''} ${th.root.resolved ? 'resolved' : ''}`}
                onClick={() => {
                  store.setDraft(null);
                  store.setOpen(th.root.id);
                  // bring the pin into view
                  const p = pinPoint(editor, th.root);
                  const s = editor.toScreen(p);
                  const { width, height } = editor.viewSize;
                  if (s.x < 40 || s.y < 40 || s.x > width - 320 || s.y > height - 40) {
                    const v = editor.viewport;
                    editor.setViewport({ ...v, x: width / 2 - 140 - p.x * v.zoom, y: height / 2 - p.y * v.zoom });
                  }
                }}
              >
                <span className="comment-pin static" aria-hidden="true">
                  {th.number}
                </span>
                <span className="comment-item-text">
                  <span className="comment-item-body">{th.root.body}</span>
                  <span className="file-time">
                    {th.replies.length ? (th.replies.length === 1 ? t('1 reply, ') : t('{n} replies, ', { n: th.replies.length })) : ''}
                    {when.format(new Date(th.root.createdAt))}
                    {th.root.resolved ? t(', resolved') : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
