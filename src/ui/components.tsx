import { createPortal } from 'react-dom';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import type { Theme } from './hooks.ts';
import { LANGUAGES, getLang, setLang, t, useLang } from './i18n.ts';

export function IconButton(props: {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  shortcut?: string;
  tooltipSide?: 'right' | 'bottom' | 'left' | 'top';
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
  const label = { system: t('Theme: match system'), light: t('Theme: light'), dark: t('Theme: dark') }[theme];
  return (
    <IconButton label={label} onClick={() => setTheme(next[theme])}>
      {theme === 'system' ? <Monitor size={16} strokeWidth={1.5} /> : theme === 'light' ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
    </IconButton>
  );
}

/** Picks the interface language; the menu names each language in itself. */
export function LanguageMenu() {
  const lang = useLang();
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span ref={anchor} className="more-anchor">
        <IconButton
          label={t('Language')}
          onClick={() => {
            const r = anchor.current!.getBoundingClientRect();
            setOpen({ x: r.right - 160, y: r.bottom + 4 });
          }}
        >
          <Languages size={16} strokeWidth={1.5} />
        </IconButton>
      </span>
      {open && (
        <Menu
          label={t('Language')}
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
          items={LANGUAGES.map((l) => ({ label: `${lang === l.lang ? '✓ ' : ''}${l.name}`, onSelect: () => setLang(l.lang) }))}
        />
      )}
    </>
  );
}

export type MenuItem =
  | { label: string; shortcut?: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | 'separator';

/** A small popup menu positioned at a point (context menu) or under an anchor. */
/** Clicks this soon after a long-press menu opens are the finger that opened it lifting (ms). */
const MENU_ARM_MS = 400;

/**
 * A menu at (x, y); with `above`, its bottom edge sits at y instead (for menus opened from the
 * bottom). `fromLongPress` ignores the release of the finger that opened it.
 */
export function Menu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void; label: string; above?: boolean; fromLongPress?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  // the finger that long-pressed to open it lifts over an item: that release is not a choice
  const [openedAt] = useState(() => performance.now());

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(props.above ? props.y - r.height : props.y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [props.x, props.y, props.above]);

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

  // straight under <body>: a fixed menu inside a transformed bar (the dock, the diagram bar) would be
  // placed relative to that bar, not the screen
  return createPortal(
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
            onClick={(e) => {
              if (props.fromLongPress && e.detail > 0 && performance.now() - openedAt < MENU_ARM_MS) return;
              props.onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';

/** Dates in the interface language (the browser's own format in English). */
export const dateLocale = () => (getLang() === 'ko' ? 'ko-KR' : undefined);

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return t('Edited just now');
  if (min < 60) return t('Edited {n} min ago', { n: min });
  const h = Math.round(min / 60);
  if (h < 24) return t('Edited {n} h ago', { n: h });
  const d = Math.round(h / 24);
  if (d < 30) return t('Edited {n} d ago', { n: d });
  return t('Edited {date}', { date: new Date(iso).toLocaleDateString(dateLocale()) });
}
