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

/** One frame of a smart animate transition at t (see `prepareTween`). */
export function tweenScreens(from: SceneDoc, fromRoot: string, to: SceneDoc, toRoot: string, t: number): SceneDoc {
  return prepareTween(from, fromRoot, to, toRoot)(t);
}

/**
 * Smart animate between two screens. Matching layers by name path, finding what leaves and what the
 * instances need is done once; the returned function makes one frame at t (0..1, already eased):
 * the destination screen with every layer that has a namesake in the source moved, sized, turned,
 * faded and recoloured from where it was; layers only in the destination fade in, layers only in
 * the source fade out. The frame is a document with the destination's root id.
 */
export function prepareTween(from: SceneDoc, fromRoot: string, to: SceneDoc, toRoot: string): (t: number) => SceneDoc {
  const a = paths(from, fromRoot);
  const b = paths(to, toRoot);
  const srcRoot = from.get(fromRoot)!;
  const dstRoot = to.get(toRoot)!;
  const pairs: { dst: SceneNode; src: SceneNode | null }[] = [];
  for (const [key, id] of b) {
    const dst = to.get(id)!;
    const srcId = a.get(key);
    const src = srcId ? from.get(srcId) : undefined;
    pairs.push({ dst, src: src && src.type === dst.type ? src : null });
  }
  // layers that leave: under their namesake parent if it stays, else under the screen; their
  // children come along unchanged (ids get a prefix so they can't meet the destination's)
  const leaving: SceneNode[] = [];
  const carried: SceneNode[] = [];
  const parentKey = (key: string) => key.slice(0, key.lastIndexOf('/'));
  const LEAVE = 'leave_';
  for (const [key, id] of a) {
    if (b.has(key)) continue;
    const pk = parentKey(key);
    if (pk && !b.has(pk)) continue; // its parent leaves too and carries it
    const src = from.get(id)!;
    leaving.push({ ...src, id: LEAVE + id, parentId: pk ? b.get(pk)! : toRoot });
    for (const d of from.descendants(id)) {
      const n = from.get(d)!;
      carried.push({ ...n, id: LEAVE + d, parentId: LEAVE + n.parentId });
    }
  }
  // every component the frame can draw: instances' components, swap targets, and what those use
  const extra: SceneNode[] = [];
  const have = new Set<string>([toRoot, ...pairs.map((p) => p.dst.id), ...leaving.map((n) => n.id), ...carried.map((n) => n.id)]);
  const queue: string[] = [];
  const want = (n: SceneNode) => {
    if (n.type === 'INSTANCE' && n.componentId) queue.push(n.componentId);
    for (const v of Object.values(n.propValues ?? {})) if (typeof v === 'string') queue.push(v);
    for (const p of n.componentProps ?? []) if (p.type === 'INSTANCE_SWAP') queue.push(p.defaultValue);
  };
  [dstRoot, ...pairs.map((p) => p.dst), ...leaving, ...carried].forEach(want);
  const doneComps = new Set<string>();
  while (queue.length && extra.length < 200_000) {
    const cid = queue.pop()!;
    const src = to.get(cid) ? to : from.get(cid) ? from : null;
    if (!src || doneComps.has(cid) || src.get(cid)!.type !== 'COMPONENT') continue;
    doneComps.add(cid);
    for (const d of [...src.ancestors(cid), cid, ...src.descendants(cid)]) {
      if (have.has(d)) continue;
      const n = src.get(d)!;
      extra.push(n);
      have.add(d);
      want(n);
    }
  }
  return (t: number) => {
    const mix = (s: SceneNode, d: SceneNode): SceneNode => {
      const sf = firstSolid(s);
      const df = firstSolid(d);
      const fills = sf && df ? d.fills.map((p) => (p === df ? { ...df, color: lerpColor(sf.color, df.color, t), opacity: lerp(sf.opacity, df.opacity, t) } : p)) : d.fills;
      return {
        ...d,
        x: lerp(s.x, d.x, t),
        y: lerp(s.y, d.y, t),
        width: Math.max(0.01, lerp(s.width, d.width, t)),
        height: d.type === 'LINE' ? 0 : Math.max(0.01, lerp(s.height, d.height, t)),
        rotation: lerp(s.rotation, d.rotation, t),
        opacity: lerp(s.opacity, d.opacity, t),
        fills,
        radii: s.radii && d.radii ? (d.radii.map((r, i) => lerp(s.radii![i], r, t)) as [number, number, number, number]) : d.radii,
      };
    };
    // the screen itself stays where the destination is; only its look changes
    const nodes: SceneNode[] = [
      { ...mix(srcRoot, dstRoot), x: dstRoot.x, y: dstRoot.y, width: dstRoot.width, height: dstRoot.height, rotation: 0, parentId: null, pageId: undefined },
    ];
    for (const p of pairs) nodes.push(p.src ? mix(p.src, p.dst) : t === 1 ? p.dst : { ...p.dst, opacity: p.dst.opacity * t });
    for (const n of leaving) nodes.push({ ...n, opacity: n.opacity * (1 - t) });
    const out = new SceneDoc();
    out.load([...nodes, ...carried, ...extra], to.defaultPage);
    return out;
  };
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
