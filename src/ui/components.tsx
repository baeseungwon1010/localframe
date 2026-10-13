import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { Theme } from './hooks.ts';

export function IconButton(props: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  shortcut?: string;
  tooltipSide?: 'right' | 'bottom' | 'left';
}) {
  const { label, onClick, pressed, disabled, children, className, shortcut, tooltipSide = 'bottom' } = props;
  return (
    <button
      type="button"
      className={`icon-btn ${className ?? ''}`}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      data-tip={shortcut ? `${label}  ${shortcut}` : label}
      data-tip-side={tooltipSide}
    >
      {children}
    </button>
  );
}

export function ThemeToggle({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const label = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' }[theme];
  return (
    <IconButton label={label} onClick={() => setTheme(next[theme])}>
      {theme === 'system' ? <Monitor size={16} strokeWidth={1.5} /> : theme === 'light' ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
    </IconButton>
  );
}

export type MenuItem =
  | { label: string; shortcut?: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | 'separator';

/** A small popup menu positioned at a point (context menu) or under an anchor. */
export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [props.x, props.y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', props.onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', props.onClose);
    };
  }, [props]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
    next?.focus();
  };

  return (
    <div ref={ref} className="menu" role="menu" aria-label={props.label} style={{ left: pos.x, top: pos.y }} onKeyDown={onKeyDown}>
      {props.items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              props.onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'Edited just now';
  if (min < 60) return `Edited ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `Edited ${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `Edited ${d} d ago`;
  return `Edited ${new Date(iso).toLocaleDateString()}`;
}
