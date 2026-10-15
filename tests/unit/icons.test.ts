import { describe, expect, it } from 'vitest';
import { icons, license } from 'virtual:lucide-icons';
import { SceneDoc } from '../../src/engine/doc.ts';
import { importSvg } from '../../src/engine/svgImport.ts';
import { iconSvg, iconTitle } from '../../src/ui/icons.ts';
import { SceneNodeSchema, validateTree } from '../../shared/schema.ts';

describe('icons', () => {
  it('come from the installed Lucide package, with its license', () => {
    expect(icons.length).toBeGreaterThan(1500);
    expect(new Set(icons.map(([n]) => n)).size).toBe(icons.length);
    expect(icons.find(([n]) => n === 'heart')![1][0][0]).toBe('path');
    expect(license).toMatch(/ISC License/);
  });

  it('every icon imports as valid, editable layers', { timeout: 60_000 }, () => {
    for (const [name, elements] of icons) {
      const doc = new SceneDoc();
      doc.load([], 'page-1');
      const nodes = importSvg(doc, iconSvg(elements), { parentId: null, at: { x: 0, y: 0 }, name: iconTitle(name) });
      expect(nodes.length, name).toBeGreaterThan(1);
      for (const n of nodes) expect(SceneNodeSchema.safeParse(n).success, name).toBe(true);
      nodes.forEach((n) => doc.set(n));
      expect(validateTree([...doc.all()], [{ id: 'page-1', name: 'Page 1', background: '#FFFFFF' }]), name).toBeNull();
      expect(nodes[0]).toMatchObject({ width: 48, height: 48, name: iconTitle(name) });
    }
  });
});
