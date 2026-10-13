import type { SceneNode } from '../../shared/schema.ts';
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
    const o = inst.overrides?.[src.id];
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

/** Text layers of a component that an instance can override, in reading order. */
export function overridableTexts(root: SceneDoc, componentId: string): SceneNode[] {
  return root
    .descendants(componentId)
    .map((id) => root.get(id)!)
    .filter((n) => n.type === 'TEXT');
}
