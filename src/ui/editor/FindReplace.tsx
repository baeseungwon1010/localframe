import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import { useEditorRev } from '../hooks.ts';
import { t } from '../i18n.ts';

/** Find text on the page (or in the selection), step through matches and replace them. */
export function FindReplace({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const rev = useEditorRev(editor, 'doc', 'pages');
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  // the selection when the panel opened decides whether "in selection" is offered
  const [inSelection, setInSelection] = useState(() => editor.selection.some((id) => editor.doc.get(id)?.type !== 'TEXT'));
  const [scopeIds] = useState(() => editor.selection);
  const [message, setMessage] = useState<string | null>(null);
  const cursor = useRef(-1);
  const input = useRef<HTMLInputElement>(null);

  // inside what was selected when the panel opened, not what "Next" selects
  const opts = { matchCase, within: inSelection ? scopeIds : null };
  // rev: search again when the document changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const found = useMemo(() => editor.findText(query, opts), [editor, query, matchCase, inSelection, scopeIds, rev]);
  const total = found.reduce((s, f) => s + f.count, 0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    cursor.current = -1;
    setMessage(null);
  }, [query, matchCase, inSelection]);

  const next = () => {
    if (!found.length) return;
    cursor.current = (cursor.current + 1) % found.length;
    editor.setSelection([found[cursor.current].id]);
    editor.zoomToSelection();
  };

  const replaceAll = () => {
    const n = editor.replaceText(query, replacement, opts);
    setMessage(n ? (n === 1 ? t('Replaced 1 match') : t('Replaced {n} matches', { n })) : t('Nothing to replace'));
  };

  const keys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      next();
    }
  };

  return (
    <div className="find-panel" role="dialog" aria-label={t('Find and replace')} onKeyDown={keys}>
      <div className="find-head">
        <span className="find-title">{t('Find and replace')}</span>
        <button type="button" className="mini-btn" aria-label={t('Close')} onClick={onClose}>
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
      <input ref={input} className="hex-input override-input" value={query} placeholder={t('Find text')} aria-label={t('Find')} maxLength={1000} onChange={(e) => setQuery(e.target.value)} />
      <input className="hex-input override-input" value={replacement} placeholder={t('Replace with')} aria-label={t('Replace with')} maxLength={10_000} onChange={(e) => setReplacement(e.target.value)} />
      <div className="find-options">
        <label className="check-row">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
          {t('Match case')}
        </label>
        {scopeIds.length > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={inSelection} onChange={(e) => setInSelection(e.target.checked)} />
            {t('Only in selection')}
          </label>
        )}
      </div>
      <p className="field-caption" role="status">
        {message ??
          (query
            ? total
              ? total === 1
                ? t('1 match in 1 text layer')
                : found.length === 1
                  ? t('{n} matches in 1 text layer', { n: total })
                  : t('{n} matches in {layers} text layers', { n: total, layers: found.length })
              : t('No matches on this page')
            : t('Text inside instances is changed in their main component.'))}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn secondary small" disabled={!found.length} onClick={next}>
          {t('Next')}
        </button>
        <button type="button" className="btn primary small" disabled={!found.length} onClick={replaceAll}>
          {t('Replace all')}
        </button>
      </div>
    </div>
  );
}
