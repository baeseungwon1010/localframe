import { type Effect, type GradientPaint, type Paint, type SceneNode, isGradientPaint } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { fontStack } from './text.ts';

/** A number as CSS wants it: at most two decimals, no trailing zeros. */
const n = (v: number) => String(Math.round(v * 100) / 100);
const px = (v: number) => (v === 0 ? '0' : `${n(v)}px`);

function rgba(hex: string, alpha: number): string {
  if (alpha >= 1) return hex.toLowerCase();
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${n(alpha)})`;
}

function gradientCss(p: GradientPaint, w: number, h: number): string {
  const stops = p.stops.map((s) => `${rgba(s.color, s.opacity * p.opacity)} ${n(s.position * 100)}%`).join(', ');
  if (p.type === 'GRADIENT_ANGULAR') {
    const from = (Math.atan2((p.to.y - p.from.y) * h, (p.to.x - p.from.x) * w) * 180) / Math.PI + 90;
    return `conic-gradient(from ${n(from)}deg at ${n(p.from.x * 100)}% ${n(p.from.y * 100)}%, ${stops})`;
  }
  if (p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_DIAMOND') {
    // CSS has no diamond gradient: the nearest is a radial one
    const rx = Math.hypot((p.to.x - p.from.x) * w, (p.to.y - p.from.y) * h);
    return `radial-gradient(circle ${px(rx)} at ${n(p.from.x * 100)}% ${n(p.from.y * 100)}%, ${stops})`;
  }
  // CSS angles: 0deg points up, clockwise
  const deg = (Math.atan2((p.to.y - p.from.y) * h, (p.to.x - p.from.x) * w) * 180) / Math.PI + 90;
  return `linear-gradient(${n(((deg % 360) + 360) % 360)}deg, ${stops})`;
}

/** Fills as CSS backgrounds, top paint first (CSS stacks the first one on top). */
function backgrounds(paints: Paint[], w: number, h: number): string[] {
  return paints
    .filter((p) => p.visible)
    .reverse()
    .map((p) => {
      if (isGradientPaint(p)) return gradientCss(p, w, h);
      if (p.type === 'IMAGE') return `url(image.png) center / ${p.scaleMode === 'fit' ? 'contain' : p.scaleMode === 'stretch' ? '100% 100%' : 'cover'} no-repeat`;
      return rgba(p.color, p.opacity);
    });
}

function shadows(effects: Effect[]): string | null {
  const list = effects
    .filter((e) => e.visible && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'))
    .map((e) => {
      const s = e as Extract<Effect, { type: 'DROP_SHADOW' | 'INNER_SHADOW' }>;
      return `${s.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(s.x)} ${px(s.y)} ${px(s.blur)} ${px(s.spread)} ${rgba(s.color, s.opacity)}`;
    });
  return list.length ? list.join(', ') : null;
}

const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' } as const;
const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const;

/**
 * CSS that reproduces a layer on its own: box, position in its parent, paint, borders, corners,
 * effects, text and auto layout. Rotation and vector paths are noted rather than translated.
 */
export function cssFor(doc: SceneDoc, node: SceneNode): string[] {
  const out: string[] = [];
  const add = (prop: string, value: string | null | undefined) => value && out.push(`${prop}: ${value};`);
  const parent = node.parentId ? doc.get(node.parentId) : undefined;
  const inFlow = parent?.layout && !node.layoutChild?.absolute;

  if (node.type === 'TEXT' && node.text?.autoResize === 'width') add('width', 'max-content');
  else if (inFlow && (parent!.layout!.mode === 'horizontal' ? node.layoutChild?.horizontal : node.layoutChild?.vertical) === 'fill') add('flex', '1 0 0');
  else add('width', px(node.width));
  if (!(node.type === 'TEXT' && node.text?.autoResize !== 'none')) add('height', px(node.height));
  if (node.minWidth) add('min-width', px(node.minWidth));
  if (node.maxWidth) add('max-width', px(node.maxWidth));
  if (node.minHeight) add('min-height', px(node.minHeight));
  if (node.maxHeight) add('max-height', px(node.maxHeight));
  if (parent && !inFlow) {
    add('position', 'absolute');
    add('left', px(node.x));
    add('top', px(node.y));
  }
  if (node.rotation) add('transform', `rotate(${n(node.rotation)}deg)`);
  if (node.rotation) add('transform-origin', 'top left');

  if (node.layout) {
    const L = node.layout;
    add('display', 'flex');
    add('flex-direction', L.mode === 'horizontal' ? 'row' : 'column');
    if (L.wrap && L.mode === 'horizontal') {
      add('flex-wrap', 'wrap');
      add('row-gap', px(L.counterGap ?? L.gap));
      add('column-gap', px(L.gap));
    } else if (L.primaryAlign !== 'space-between') add('gap', px(L.gap));
    add('justify-content', JUSTIFY[L.primaryAlign]);
    add('align-items', ALIGN[L.crossAlign]);
    const [t, r, b, l] = L.padding;
    add('padding', t === b && l === r ? (t === l ? px(t) : `${px(t)} ${px(r)}`) : `${px(t)} ${px(r)} ${px(b)} ${px(l)}`);
  }
  if ((node.type === 'FRAME' || node.type === 'COMPONENT') && node.clipsContent) add('overflow', 'hidden');

  if (node.type === 'TEXT' && node.text) {
    const t = node.text;
    const fill = node.fills.find((p) => p.visible);
    if (fill && fill.type !== 'IMAGE' && !isGradientPaint(fill)) add('color', rgba(fill.color, fill.opacity));
    add('font-family', fontStack(t.fontFamily));
    add('font-size', px(t.fontSize));
    add('font-weight', String(t.fontWeight));
    if (t.italic) add('font-style', 'italic');
    add('line-height', t.lineHeight === null ? 'normal' : px(t.lineHeight));
    if (t.letterSpacing) add('letter-spacing', px(t.letterSpacing));
    if (t.align !== 'left') add('text-align', t.align);
    if (t.decoration && t.decoration !== 'none') add('text-decoration', t.decoration === 'strikethrough' ? 'line-through' : 'underline');
  } else if (node.type !== 'LINE') {
    const bg = backgrounds(node.fills, node.width, node.height);
    if (bg.length === 1 && !bg[0].includes('(')) add('background', bg[0]);
    else if (bg.length) add('background', bg.join(', '));
  }

  const stroke = node.strokes.find((p) => p.visible);
  if (stroke && node.strokeWeight > 0) {
    const color = isGradientPaint(stroke) ? rgba(stroke.stops[0].color, stroke.stops[0].opacity) : rgba(stroke.color, stroke.opacity);
    const style = node.strokeDash.length ? 'dashed' : 'solid';
    if (node.type === 'LINE') {
      add('border-top', `${px(node.strokeWeight)} ${style} ${color}`);
    } else if (node.strokeAlign === 'inside') {
      // inside strokes don't change the box: an inset shadow draws them in place
      out.push(`box-shadow: inset 0 0 0 ${px(node.strokeWeight)} ${color};`);
    } else add('border', `${px(node.strokeWeight)} ${style} ${color}`);
  }

  if (node.type === 'ELLIPSE') add('border-radius', '50%');
  else if (node.radii && node.radii.some((r) => r > 0)) {
    const [a, b, c, d] = node.radii;
    add('border-radius', a === b && b === c && c === d ? px(a) : `${px(a)} ${px(b)} ${px(c)} ${px(d)}`);
  }

  const effects = node.effects ?? [];
  const shadow = shadows(effects);
  if (shadow) {
    const i = out.findIndex((l) => l.startsWith('box-shadow:'));
    if (i >= 0) out[i] = out[i].replace(/;$/, `, ${shadow};`);
    else add('box-shadow', shadow);
  }
  const blur = effects.find((e) => e.visible && e.type === 'LAYER_BLUR');
  if (blur && blur.type === 'LAYER_BLUR') add('filter', `blur(${px(blur.radius / 2)})`);
  const bgBlur = effects.find((e) => e.visible && e.type === 'BACKGROUND_BLUR');
  if (bgBlur && bgBlur.type === 'BACKGROUND_BLUR') add('backdrop-filter', `blur(${px(bgBlur.radius / 2)})`);
  if (node.opacity < 1) add('opacity', n(node.opacity));
  if (node.blendMode && node.blendMode !== 'normal') add('mix-blend-mode', node.blendMode);
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN') out.push('/* a vector shape: export it as SVG */');
  return out;
}
