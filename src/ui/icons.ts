/** Lucide icons as SVG text, the way they are inserted (see IconPicker). */

export type IconElement = [string, Record<string, string | number>];

const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * An icon as an SVG drawing: Lucide's 24-unit grid, stroked in `color`, drawn at `size` pixels
 * (the stroke grows with it, as when an icon is scaled).
 */
export function iconSvg(elements: IconElement[], size = 48, color = '#1E1E1E'): string {
  const body = elements
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${esc(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** "arrow-big-right" → "Arrow big right": the layer's name. */
export const iconTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');
