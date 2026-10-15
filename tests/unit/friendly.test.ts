import { describe, expect, it } from 'vitest';
import { Editor } from '../../src/engine/editor.ts';
import { buildCommands, filterCommands } from '../../src/ui/editor/commands.ts';
import { sampleFile } from '../../src/ui/sampleFile.ts';
import { ExportedFileSchema, validateTree } from '../../shared/schema.ts';

describe('friendlier interface', () => {
  it('the sample file is a valid file', () => {
    const parsed = ExportedFileSchema.safeParse(sampleFile());
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 2))).toBe(true);
    expect(validateTree(parsed.data!.nodes, parsed.data!.pages!)).toBeNull();
  });

  it('quick actions find commands by any words and say why one cannot run', () => {
    const ed = new Editor();
    const noop = () => {};
    const all = buildCommands(ed, { exportFile: noop, present: noop, history: noop, find: noop, placeImage: noop, rename: noop });
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(filterCommands(all, 'stroke outline').map((c) => c.id)).toEqual(['outline-stroke']);
    expect(filterCommands(all, 'circle').map((c) => c.id)).toContain('tool-ellipse');
    const flatten = all.find((c) => c.id === 'flatten')!;
    expect(flatten.unavailable()).toBe('Select a layer first');
    const rect = all.find((c) => c.id === 'tool-rect')!;
    rect.run();
    expect(ed.tool).toBe('rect');
  });
});
