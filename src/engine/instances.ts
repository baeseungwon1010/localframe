import type { ComponentProp, SceneNode } from '../../shared/schema.ts';
import { SceneDoc } from './doc.ts';
import { applyConstraints } from './geometry.ts';
import { applyAutoLayout } from './layout.ts';
import { fitText } from './nodes.ts';

const SEP = '~';

/**
 * An instance has no stored children. Its content is the main component's content, adapted to the
 * instance's size and with the instance's overrides applied. This builds that content as a small
 * standalone document whose root has the instance's id (drawn at the origin).
 */
const cache = new WeakMap<SceneNode, { version: number; doc: SceneDoc | null }>();

export function instanceDoc(root: SceneDoc, inst: SceneNode): SceneDoc | null {
  const hit = cache.get(inst);
  if (hit && hit.version === root.version) return hit.doc;
  const doc = build(root, inst);
  cache.set(inst, { version: root.version, doc });
  return doc;
}

/** Source layer id inside the main component for a virtual id. */
export const sourceId = (virtualId: string) => virtualId.slice(virtualId.indexOf(SEP) + 1);

function build(root: SceneDoc, inst: SceneNode): SceneDoc | null {
  const comp = inst.componentId ? root.get(inst.componentId) : undefined;
  if (!comp || comp.type !== 'COMPONENT') return null;
  const props = componentPropsOf(root, comp.id);
  const propValue = (propId: string) => {
    const def = props.find((p) => p.id === propId);
    if (!def) return undefined;
    const v = inst.propValues && Object.hasOwn(inst.propValues, propId) ? inst.propValues[propId] : undefined;
    return typeof v === typeof def.defaultValue ? v : def.defaultValue;
  };
  const map = new Map<string, string>([[comp.id, inst.id]]);
  const vid = (id: string) => {
    let v = map.get(id);
    if (!v) map.set(id, (v = `${inst.id}${SEP}${id}`));
    return v;
  };
  const nodes: SceneNode[] = [
    {
      ...comp,
      id: inst.id,
      type: 'FRAME',
      parentId: null,
      pageId: undefined,
      x: 0,
      y: 0,
      rotation: 0,
      width: comp.width,
      height: comp.height,
      name: inst.name,
      visible: true,
      locked: false,
      opacity: 1,
      constraints: undefined,
      layoutChild: undefined,
    },
  ];
  for (const d of root.descendants(comp.id)) {
    const src = root.get(d)!;
    let n: SceneNode = { ...src, id: vid(src.id), parentId: vid(src.parentId!) };
    if (n.startBind) n = { ...n, startBind: { ...n.startBind, nodeId: vid(n.startBind.nodeId) } };
    if (n.endBind) n = { ...n, endBind: { ...n.endBind, nodeId: vid(n.endBind.nodeId) } };
    // linked component properties first, then this instance's own overrides
    if (n.propRefs?.visible) {
      const v = propValue(n.propRefs.visible);
      if (typeof v === 'boolean') n = { ...n, visible: v };
    }
    if (n.propRefs?.characters && n.text) {
      const v = propValue(n.propRefs.characters);
      if (typeof v === 'string') n = fitText({ ...n, text: { ...n.text, characters: v } });
    }
    const o = inst.overrides && Object.hasOwn(inst.overrides, src.id) ? inst.overrides[src.id] : undefined;
    if (o) {
      if (o.visible !== undefined) n = { ...n, visible: o.visible };
      if (o.fills) n = { ...n, fills: o.fills };
      if (o.characters !== undefined && n.text) n = fitText({ ...n, text: { ...n.text, characters: o.characters } });
    }
    nodes.push(n);
  }
  const doc = new SceneDoc();
  doc.load(nodes);

  // Re-run auto layout inside (overrides can change sizes), deepest frames first.
  const containers = nodes.filter((n) => n.layout).map((n) => n.id);
  containers.sort((a, b) => doc.depth(b) - doc.depth(a));
  for (const id of containers) {
    const f = doc.get(id)!;
    const kids = doc.children(id).map((k) => doc.get(k)!);
    const out = applyAutoLayout(f, kids);
    for (const k of out.kids) doc.set(k);
    doc.set(out.frame);
  }

  // Adapt to the instance's size: auto layout recomputes, otherwise children follow their constraints.
  const vroot = doc.get(inst.id)!;
  if (Math.abs(vroot.width - inst.width) > 0.001 || Math.abs(vroot.height - inst.height) > 0.001) {
    const w0 = vroot.width;
    const h0 = vroot.height;
    const sized = { ...vroot, width: inst.width, height: inst.height };
    if (sized.layout) {
      const fixed = { ...sized, layout: { ...sized.layout, widthMode: 'fixed' as const, heightMode: 'fixed' as const } };
      const out = applyAutoLayout(fixed, doc.children(inst.id).map((k) => doc.get(k)!));
      for (const k of out.kids) doc.set(k);
      doc.set({ ...out.frame, layout: sized.layout });
    } else {
      doc.set(sized);
      const resize = (frameId: string, fw0: number, fh0: number, fw1: number, fh1: number) => {
        const kids = doc.children(frameId).map((k) => doc.get(k)!);
        applyConstraints(kids, fw0, fh0, fw1, fh1).forEach((c, i) => {
          doc.set(fitText(c));
          if ((c.type === 'FRAME' || c.type === 'COMPONENT') && !c.layout && (c.width !== kids[i].width || c.height !== kids[i].height))
            resize(c.id, kids[i].width, kids[i].height, c.width, c.height);
        });
      };
      resize(inst.id, w0, h0, inst.width, inst.height);
    }
  }
  return doc;
}

/** Properties of a component: its own, or those of the component set it belongs to. */
export function componentPropsOf(root: SceneDoc, componentId: string): ComponentProp[] {
  const comp = root.get(componentId);
  if (!comp) return [];
  const parent = comp.parentId ? root.get(comp.parentId) : undefined;
  return [...(parent?.type === 'COMPONENT_SET' ? (parent.componentProps ?? []) : []), ...(comp.componentProps ?? [])];
}

/** Variant properties of a component set and the values its variants use. */
export function variantOptions(root: SceneDoc, setId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of root.children(setId)) {
    const c = root.get(id)!;
    for (const [k, v] of Object.entries(c.variant ?? {})) {
      const list = out.get(k) ?? [];
      if (!list.includes(v)) list.push(v);
      out.set(k, list);
    }
  }
  return out;
}

/** "Size=Large, State=Default" */
export const variantName = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, val]) => `${k}=${val}`)
    .join(', ')
    .slice(0, 500) || 'Variant';

/** Names from the component down to a layer, used to carry overrides across variants. */
export function namePath(root: SceneDoc, componentId: string, id: string): string {
  const names: string[] = [];
  let cur = root.get(id);
  while (cur && cur.id !== componentId) {
    names.unshift(cur.name);
    cur = cur.parentId ? root.get(cur.parentId) : undefined;
  }
  return names.join('/');
}

/** Text layers of a component that an instance can override, in reading order. */
export function overridableTexts(root: SceneDoc, componentId: string): SceneNode[] {
  return root
    .descendants(componentId)
    .map((id) => root.get(id)!)
    .filter((n) => n.type === 'TEXT');
}
