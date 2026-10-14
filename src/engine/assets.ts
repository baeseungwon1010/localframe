import type { Bindable, Effect, Paint, SceneNode, Style, StrokePaint, Variables } from '../../shared/schema.ts';
import type { SceneDoc } from './doc.ts';
import { fitText, solid } from './nodes.ts';

export type StyleField = 'fill' | 'stroke' | 'text' | 'effect';
export const STYLE_KEY: Record<StyleField, 'fillStyleId' | 'strokeStyleId' | 'textStyleId' | 'effectStyleId'> = {
  fill: 'fillStyleId',
  stroke: 'strokeStyleId',
  text: 'textStyleId',
  effect: 'effectStyleId',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The part of a layer a style of this field controls. */
export function styledValue(n: SceneNode, field: StyleField): unknown {
  if (field === 'fill') return n.fills;
  if (field === 'stroke') return n.strokes;
  if (field === 'effect') return n.effects ?? [];
  const t = n.text;
  return t ? { fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontSize: t.fontSize, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing } : null;
}

/** Writes a style's value into a layer. */
export function applyStyleValue(n: SceneNode, field: StyleField, style: Style): SceneNode {
  if (field === 'fill' && style.type === 'FILL') return { ...n, fills: style.value };
  if (field === 'stroke' && style.type === 'FILL') return { ...n, strokes: style.value.filter((p): p is StrokePaint => p.type !== 'IMAGE') };
  if (field === 'effect' && style.type === 'EFFECT') return { ...n, effects: style.value };
  if (field === 'text' && style.type === 'TEXT' && n.text) return fitText({ ...n, text: { ...n.text, ...style.value } });
  return n;
}

export function styleMatches(n: SceneNode, field: StyleField, style: Style): boolean {
  if (field === 'stroke') return same(n.strokes, style.type === 'FILL' ? style.value.filter((p) => p.type !== 'IMAGE') : null);
  return same(styledValue(n, field), style.value);
}

/** A new style made from a layer's current look. */
export function styleFrom(n: SceneNode, field: StyleField, id: string, name: string): Style | null {
  if (field === 'fill' && n.fills.length) return { id, name, type: 'FILL', value: n.fills as Paint[] };
  if (field === 'stroke' && n.strokes.length) return { id, name, type: 'FILL', value: n.strokes as Paint[] };
  if (field === 'effect' && (n.effects ?? []).length) return { id, name, type: 'EFFECT', value: n.effects as Effect[] };
  if (field === 'text' && n.text) {
    const t = n.text;
    return { id, name, type: 'TEXT', value: { fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontSize: t.fontSize, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing } };
  }
  return null;
}

// ------------------------------------------------------------- variables

/** The mode a layer sees for a collection: the nearest choice up its ancestors, or the first mode. */
export function modeFor(doc: SceneDoc, vars: Variables, nodeId: string, collectionId: string): string | null {
  const col = vars.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  let cur = doc.get(nodeId);
  for (let guard = 0; cur && guard < 200; guard++) {
    const m = cur.modes?.[collectionId];
    if (m && col.modes.some((x) => x.id === m)) return m;
    cur = cur.parentId ? doc.get(cur.parentId) : undefined;
  }
  return col.modes[0].id;
}

export function variableValue(doc: SceneDoc, vars: Variables, nodeId: string, varId: string): string | number | boolean | null {
  const v = vars.vars.find((x) => x.id === varId);
  if (!v) return null;
  const mode = modeFor(doc, vars, nodeId, v.collectionId);
  if (!mode) return null;
  const col = vars.collections.find((c) => c.id === v.collectionId)!;
  const value = v.values[mode] ?? v.values[col.modes[0].id];
  return value ?? null;
}

const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Writes one bound property from its variable's value. */
function setBound(n: SceneNode, prop: Bindable, value: string | number | boolean): SceneNode {
  if (prop === 'characters') return typeof value === 'string' && n.text ? fitText({ ...n, text: { ...n.text, characters: value.slice(0, 100_000) } }) : n;
  if (prop === 'visible') return typeof value === 'boolean' ? { ...n, visible: value } : n;
  if ((prop === 'fill' || prop === 'stroke') && typeof value === 'string') {
    const list = prop === 'fill' ? n.fills : n.strokes;
    const first = list[0];
    const paint = first && (first.type === undefined || first.type === 'SOLID') ? { ...first, color: value } : solid(value);
    const next = [paint, ...list.slice(1)];
    return prop === 'fill' ? { ...n, fills: next } : { ...n, strokes: next as StrokePaint[] };
  }
  if (typeof value !== 'number') return n;
  switch (prop) {
    case 'radius':
      return n.radii ? { ...n, radii: [value, value, value, value].map((r) => clampN(r, 0, 1e7)) as [number, number, number, number] } : n;
    case 'gap':
      return n.layout ? { ...n, layout: { ...n.layout, gap: clampN(value, -10_000, 10_000) } } : n;
    case 'padding': {
      const p = clampN(value, 0, 10_000);
      return n.layout ? { ...n, layout: { ...n.layout, padding: [p, p, p, p] } } : n;
    }
    case 'strokeWeight':
      return { ...n, strokeWeight: clampN(value, 0, 1000) };
    case 'opacity':
      return { ...n, opacity: clampN(value / 100, 0, 1) };
    default:
      return n;
  }
}

/** A layer with every bound property set from its variable (for its modes). */
export function resolveBindings(doc: SceneDoc, vars: Variables, n: SceneNode): SceneNode {
  if (!n.bindings) return n;
  let out = n;
  for (const [prop, varId] of Object.entries(n.bindings) as [Bindable, string][]) {
    if (!varId) continue;
    const value = variableValue(doc, vars, n.id, varId);
    if (value !== null) out = setBound(out, prop, value);
  }
  return out;
}

/** The field of a layer a binding drives, for spotting direct edits. */
export function boundField(n: SceneNode, prop: Bindable): unknown {
  switch (prop) {
    case 'fill':
      return n.fills[0];
    case 'stroke':
      return n.strokes[0];
    case 'radius':
      return n.radii;
    case 'gap':
      return n.layout?.gap;
    case 'padding':
      return n.layout?.padding;
    case 'strokeWeight':
      return n.strokeWeight;
    case 'opacity':
      return n.opacity;
    case 'characters':
      return n.text?.characters;
    case 'visible':
      return n.visible;
  }
}

export const BINDING_TYPE: Record<Bindable, 'COLOR' | 'NUMBER' | 'STRING' | 'BOOLEAN'> = {
  characters: 'STRING',
  visible: 'BOOLEAN',
  fill: 'COLOR',
  stroke: 'COLOR',
  radius: 'NUMBER',
  gap: 'NUMBER',
  padding: 'NUMBER',
  strokeWeight: 'NUMBER',
  opacity: 'NUMBER',
};
