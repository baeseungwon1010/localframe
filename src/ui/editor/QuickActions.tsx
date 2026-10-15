import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import { t } from '../i18n.ts';
import { type ScreenActions, buildCommands, filterCommands } from './commands.ts';

/**
 * Quick actions (Ctrl/Cmd+/ or Ctrl/Cmd+K): find any command by name and run it. With nothing typed
 * it lists everything by group, so it also serves as the keyboard shortcut reference.
 */
export function QuickActions({ editor, screen, onClose }: { editor: Editor; screen: ScreenActions; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const all = useMemo(() => buildCommands(editor, screen), [editor, screen]);
  const list = filterCommands(all, query);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (i: number) => {
    const c = list[i];
    if (!c || c.unavailable()) return;
    onClose();
    // after the palette closes, so the command sees the canvas focused
    setTimeout(() => c.run(), 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(list.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(active);
    }
  };

  let lastGroup = '';
  return (
    <div className="dialog-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Quick actions')} onKeyDown={onKey}>
        <div className="palette-search">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder={t('Search commands and shortcuts')}
            aria-label={t('Search commands')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={list[active] ? `cmd-${list[active].id}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label={t('Commands')} ref={listRef}>
          {list.length === 0 && <li className="palette-empty">{t('No command matches “{query}”.', { query })}</li>}
          {list.map((c, i) => {
            const why = c.unavailable();
            const head = !query && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {head && <div className="palette-group">{t(head)}</div>}
                <div
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={!!why}
                  data-index={i}
                  className={`palette-item ${i === active ? 'on' : ''} ${why ? 'off' : ''}`}
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => run(i)}
                >
                  <span className="palette-label">
                    {t(c.label)}
                    {why && <span className="palette-why">{t(why)}</span>}
                  </span>
                  {query && <span className="palette-meta">{t(c.group)}</span>}
                  {c.shortcut && <kbd>{c.shortcut}</kbd>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
