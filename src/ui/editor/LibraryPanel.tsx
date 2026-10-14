import { useEffect, useMemo, useState } from 'react';
import type { FileMeta, SceneNode } from '../../../shared/schema.ts';
import { api } from '../../api.ts';
import { SceneDoc } from '../../engine/doc.ts';
import { Editor } from '../../engine/editor.ts';
import { retryFailedImages } from '../../engine/images.ts';
import { useEditorRev } from '../hooks.ts';

const KEY = (fileId: string) => `localframe.library.${fileId}`;

function remembered(fileId: string): string {
  try {
    return localStorage.getItem(KEY(fileId)) ?? '';
  } catch {
    return '';
  }
}

/**
 * Components from another file on this computer: insert them here (a copy goes on the "Library
 * components" page) and bring copies up to date when the library file changes.
 */
export function LibraryPanel({ editor }: { editor: Editor }) {
  useEditorRev(editor, 'doc');
  const fileId = editor.fileId;
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [lib, setLib] = useState(() => (fileId ? remembered(fileId) : ''));
  const [source, setSource] = useState<{ fileId: string; nodes: SceneNode[]; doc: SceneDoc } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .listFiles()
      .then((list) => live && setFiles(list.filter((f) => f.id !== fileId)))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [fileId]);

  useEffect(() => {
    let live = true;
    setSource(null);
    if (!lib) return;
    api
      .getFile(lib)
      .then(({ nodes }) => {
        if (!live) return;
        const doc = new SceneDoc();
        doc.load(nodes);
        setSource({ fileId: lib, nodes, doc });
      })
      .catch(() => live && setMessage("Couldn't open that file."));
    return () => {
      live = false;
    };
  }, [lib]);

  // versions of the library's components: worked out once per library file, not on every edit here
  const versions = useMemo(() => {
    const out = new Map<string, string>();
    if (source) for (const n of source.doc.all()) if (n.type === 'COMPONENT') out.set(n.id, Editor.libraryVersion(source.doc, n.id));
    return out;
  }, [source]);
  // this file's copies of them, in one pass
  const copies = new Map<string, string>();
  for (const n of editor.doc.all()) if (n.libraryRef?.fileId === lib) copies.set(n.libraryRef.componentId, n.libraryRef.version);

  if (!fileId || !files || files.length === 0) return null;

  const pick = (id: string) => {
    setLib(id);
    setMessage(null);
    try {
      localStorage.setItem(KEY(fileId), id);
    } catch {
      /* not remembered */
    }
  };

  const comps = source ? [...source.doc.all()].filter((n) => n.type === 'COMPONENT').sort((a, b) => a.name.localeCompare(b.name)) : [];
  const status = (c: SceneNode) => {
    const version = copies.get(c.id);
    if (version === undefined) return 'new';
    return version === versions.get(c.id) ? 'current' : 'outdated';
  };
  const outdated = comps.filter((c) => status(c) === 'outdated');

  /** Copies (or updates) a component and the images it needs; inserts an instance if asked. */
  const bring = async (ids: string[], insert: boolean) => {
    if (!source) return;
    setMessage(null);
    let last: string | null = null;
    const images = new Set<string>();
    for (const id of ids) {
      const out = editor.importLibraryComponent(source, id);
      if (!out) {
        setMessage('That component is too large to copy into this file.');
        return;
      }
      last = out.id;
      out.images.forEach((i) => images.add(i));
    }
    if (images.size) {
      try {
        const list = [...images];
        for (let i = 0; i < list.length; i += 500) await api.copyImages(fileId, source.fileId, list.slice(i, i + 500));
        retryFailedImages();
        editor.emit('view');
      } catch {
        setMessage('Some images could not be copied.');
      }
    }
    if (insert && last) editor.createInstance(last, editor.toWorld(editor.viewSize.width / 2, editor.viewSize.height / 2));
    if (!insert) setMessage(`Updated ${ids.length} component${ids.length === 1 ? '' : 's'}.`);
  };

  return (
    <section className="library" aria-label="Libraries">
      <h4 className="asset-heading">Libraries</h4>
      <select className="select-field" aria-label="Library file" value={lib} onChange={(e) => pick(e.target.value)}>
        <option value="">Use components from another file…</option>
        {files.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {source && comps.length === 0 && <p className="panel-empty">That file has no components.</p>}
      {outdated.length > 0 && (
        <button type="button" className="btn secondary small full" onClick={() => void bring(outdated.map((c) => c.id), false)}>
          Update {outdated.length} changed component{outdated.length === 1 ? '' : 's'}
        </button>
      )}
      {comps.length > 0 && (
        <ul className="asset-list" aria-label="Library components">
          {comps.map((c) => {
            const st = status(c);
            return (
              <li key={c.id} className="asset-row">
                <div className="asset-text">
                  <span className="row-name">{c.name}</span>
                  <span className="file-time">{st === 'new' ? 'Not in this file yet' : st === 'current' ? 'Up to date here' : 'Changed in the library'}</span>
                </div>
                <button type="button" className="btn secondary small" onClick={() => void bring([c.id], true)}>
                  Insert
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {message && (
        <p className="field-caption" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
