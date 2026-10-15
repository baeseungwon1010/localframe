import { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { icons, license } from 'virtual:lucide-icons';
import type { Editor } from '../../engine/editor.ts';
import { IconButton } from '../components.tsx';
import { t } from '../i18n.ts';
import { type IconElement, iconSvg, iconTitle } from '../icons.ts';

/** Shown at once; typing narrows the rest. */
const SHOWN = 240;

/** One icon, drawn from its elements (no HTML strings involved). */
function IconGlyph({ elements }: { elements: IconElement[] }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {elements.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

/**
 * Lucide's icons, searchable by name; a click adds the chosen one as editable layers in the middle
 * of the view. The icons are part of the app (loaded when this opens), not fetched from anywhere.
 */
export function IconPicker({ editor, onClose, onError }: { editor: Editor; onClose: () => void; onError: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const found = useMemo(() => {
    const words = query.toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
    return words.length ? icons.filter(([name]) => words.every((w) => name.includes(w))) : icons;
  }, [query]);

  const insert = (name: string, elements: IconElement[]) => {
    try {
      editor.importSvgText(iconSvg(elements), iconTitle(name));
      onClose();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'unknown error');
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog icon-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('Insert icon')}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="icon-picker-head">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={t('Search {n} icons in English, e.g. arrow, user, heart', { n: icons.length })}
            aria-label={t('Search icons')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <IconButton label={t('Close')} onClick={onClose}>
            <X size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
        {found.length === 0 ? (
          <p className="panel-empty">{t('No icons are called “{query}”.', { query: query.trim() })}</p>
        ) : (
          <div className="icon-grid" role="list">
            {found.slice(0, SHOWN).map(([name, elements]) => (
              <button key={name} type="button" role="listitem" className="icon-cell" title={iconTitle(name)} aria-label={iconTitle(name)} onClick={() => insert(name, elements)}>
                <IconGlyph elements={elements} />
              </button>
            ))}
          </div>
        )}
        <div className="icon-picker-foot">
          {found.length > SHOWN && <span>{t('Showing {shown} of {n}: type to find the rest.', { shown: SHOWN, n: found.length })}</span>}
          <details>
            <summary>{t('Icons by Lucide (ISC License)')}</summary>
            <pre>{license}</pre>
          </details>
        </div>
      </div>
    </div>
  );
}
