import type { Reaction, SceneNode, SolidPaint, Variables } from '../../shared/schema.ts';
import { resolveBindings } from './assets.ts';
import { SceneDoc } from './doc.ts';

/** A frame you can present: on the page itself, or directly inside a section. */
export function isScreen(doc: SceneDoc, id: string): boolean {
  const n = doc.get(id);
  if (!n || n.section || n.slice || !(n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE')) return false;
  if (n.parentId === null) return true;
  return !!doc.get(n.parentId)?.section && doc.get(n.parentId)!.parentId === null;
}

/** A private copy of the file for a presentation, which interactions may change freely. */
export function presentationDoc(source: SceneDoc): SceneDoc {
  const doc = new SceneDoc();
  doc.load([...source.all()], source.defaultPage);
  doc.setCurrentPage(source.currentPage);
  return doc;
}

/** Switches a variable collection to a mode for the whole page and re-applies every bound value. */
export function setPresentationMode(doc: SceneDoc, vars: Variables, collectionId: string, modeId: string): boolean {
  const col = vars.collections.find((c) => c.id === collectionId);
  if (!col || !col.modes.some((m) => m.id === modeId)) return false;
  for (const id of doc.children(null)) {
    const n = doc.get(id)!;
    doc.set({ ...n, modes: { ...n.modes, [collectionId]: modeId } });
  }
  // nearer choices of the same collection would win over the page: they follow the new mode too
  for (const n of [...doc.all()]) {
    if (n.parentId !== null && n.modes?.[collectionId]) doc.set({ ...n, modes: { ...n.modes, [collectionId]: modeId } });
  }
  for (const n of [...doc.all()]) {
    if (!n.bindings) continue;
    const next = resolveBindings(doc, vars, n);
    if (next !== n) doc.set(next);
  }
  return true;
}

/** Interactions of a layer; an instance without its own uses its main component's. */
export function reactionsOf(doc: SceneDoc, n: SceneNode): Reaction[] {
  if (n.reactions?.length) return n.reactions;
  if (n.type === 'INSTANCE' && n.componentId) return doc.get(n.componentId)?.reactions ?? [];
  return [];
}

/** Interactive components: an instance becomes another variant of the same set. */
export function swapVariant(doc: SceneDoc, instanceId: string, componentId: string): boolean {
  const inst = doc.get(instanceId);
  const from = inst?.componentId ? doc.get(inst.componentId) : undefined;
  const to = doc.get(componentId);
  if (!inst || inst.type !== 'INSTANCE' || !from || !to || to.type !== 'COMPONENT') return false;
  if (!from.parentId || from.parentId !== to.parentId || doc.get(from.parentId)?.type !== 'COMPONENT_SET') return false;
  doc.set({ ...inst, componentId: to.id, width: to.width, height: to.height });
  return true;
}

// ------------------------------------------------------------- smart animate

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpColor(a: string, b: string, t: number): string {
  const ch = (c: string, i: number) => parseInt(c.slice(i, i + 2), 16);
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${[1, 3, 5].map((i) => hex(lerp(ch(a, i), ch(b, i), t))).join('').toUpperCase()}`;
}

const firstSolid = (n: SceneNode): SolidPaint | undefined =>
  n.fills.find((p): p is SolidPaint => p.visible && (p.type === undefined || p.type === 'SOLID'));

/** Name path from a screen down to a layer, the key smart animate matches layers by. */
function paths(doc: SceneDoc, rootId: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (id: string, prefix: string) => {
    const seen = new Map<string, number>();
    for (const k of doc.children(id)) {
      const n = doc.get(k)!;
      // same names under one parent are told apart by their order
      const count = seen.get(n.name) ?? 0;
      seen.set(n.name, count + 1);
      const key = `${prefix}/${n.name}#${count}`;
      out.set(key, k);
      walk(k, key);
    }
  };
  walk(rootId, '');
  return out;
}

/**
 * One frame of a smart animate transition at t (0..1, already eased): the destination screen with
 * every layer that has a namesake in the source moved, sized, turned, faded and recoloured from
 * where it was; layers only in the destination fade in, layers only in the source fade out.
 * The result is a document holding just the tweened screen, with the destination's root id.
 */
export function tweenScreens(from: SceneDoc, fromRoot: string, to: SceneDoc, toRoot: string, t: number): SceneDoc {
  const a = paths(from, fromRoot);
  const b = paths(to, toRoot);
  const nodes: SceneNode[] = [];
  const mix = (src: SceneNode, dst: SceneNode): SceneNode => {
    const sf = firstSolid(src);
    const df = firstSolid(dst);
    const fills = sf && df ? dst.fills.map((p) => (p === df ? { ...df, color: lerpColor(sf.color, df.color, t), opacity: lerp(sf.opacity, df.opacity, t) } : p)) : dst.fills;
    return {
      ...dst,
      x: lerp(src.x, dst.x, t),
      y: lerp(src.y, dst.y, t),
      width: Math.max(0.01, lerp(src.width, dst.width, t)),
      height: dst.type === 'LINE' ? 0 : Math.max(0.01, lerp(src.height, dst.height, t)),
      rotation: lerp(src.rotation, dst.rotation, t),
      opacity: lerp(src.opacity, dst.opacity, t),
      fills,
      radii: src.radii && dst.radii ? (dst.radii.map((r, i) => lerp(src.radii![i], r, t)) as [number, number, number, number]) : dst.radii,
    };
  };
  const srcRoot = from.get(fromRoot)!;
  const dstRoot = to.get(toRoot)!;
  // the screen itself stays where the destination is; only its look changes
  nodes.push({ ...mix(srcRoot, dstRoot), x: dstRoot.x, y: dstRoot.y, width: dstRoot.width, height: dstRoot.height, rotation: 0, parentId: null, pageId: undefined });
  for (const [key, id] of b) {
    const dst = to.get(id)!;
    const srcId = a.get(key);
    const src = srcId ? from.get(srcId) : undefined;
    nodes.push(src && src.type === dst.type ? mix(src, dst) : { ...dst, opacity: dst.opacity * t });
  }
  // layers that leave: under their namesake parent if it stays, else under the screen
  const parentKey = (key: string) => key.slice(0, key.lastIndexOf('/'));
  for (const [key, id] of a) {
    if (b.has(key)) continue;
    const src = from.get(id)!;
    const pk = parentKey(key);
    if (pk && !b.has(pk)) continue; // its parent leaves too and carries it
    const parent = pk ? b.get(pk)! : toRoot;
    nodes.push({ ...src, id: `leave~${id}`, parentId: parent, opacity: src.opacity * (1 - t), order: src.order });
  }
  // the children of leaving layers come along with new ids
  const leaving = new Set(nodes.filter((n) => n.id.startsWith('leave~')).map((n) => n.id.slice(6)));
  for (const id of leaving) {
    for (const d of from.descendants(id)) {
      const n = from.get(d)!;
      if (leaving.has(d)) continue;
      nodes.push({ ...n, id: `leave~${d}`, parentId: `leave~${n.parentId}` });
    }
  }
  // components the screen's instances need
  const out = new SceneDoc();
  const need = new Set<string>();
  for (const n of nodes) if (n.type === 'INSTANCE' && n.componentId) need.add(n.componentId);
  const extra: SceneNode[] = [];
  const have = new Set(nodes.map((n) => n.id));
  for (const cid of need) {
    for (const d of [cid, ...to.ancestors(cid), ...to.descendants(cid)]) {
      if (have.has(d)) continue;
      const n = to.get(d);
      if (n) {
        extra.push(n);
        have.add(d);
      }
    }
  }
  out.load([...nodes, ...extra], to.defaultPage);
  return out;
}

export function ease(kind: Reaction['easing'], t: number): number {
  switch (kind) {
    case 'linear':
      return t;
    case 'ease-in':
      return t * t * t;
    case 'ease-out':
      return 1 - (1 - t) ** 3;
    default:
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  }
}
