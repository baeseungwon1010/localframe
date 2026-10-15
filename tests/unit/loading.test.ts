import { describe, expect, it } from 'vitest';
import { Editor } from '../../src/engine/editor.ts';
import { facesUsed } from '../../src/engine/text.ts';

describe('loading only what a file needs', () => {
  it('lists the faces text uses, with their characters, and always Inter', () => {
    const ed = new Editor();
    ed.setViewSize(1000, 800);
    ed.insertTemplate('flowchart');
    const [first] = [...ed.doc.all()].filter((n) => n.label);
    ed.doc.set({ ...first, label: { ...first.label!, fontFamily: 'Noto Sans KR', fontWeight: 700, characters: '시작', runs: [{ start: 0, end: 1, fontFamily: 'Space Grotesk' }] } });
    const faces = facesUsed(ed.doc.all());
    const key = (f: { family: string; weight: number }) => `${f.weight} ${f.family}`;
    expect(faces.map(key)).toEqual(expect.arrayContaining(['400 Inter', '500 Inter', '600 Inter', '700 Inter', '700 Noto Sans KR', '700 Space Grotesk']));
    expect(faces.find((f) => f.family === 'Noto Sans KR')!.text).toBe('시작');
    expect(faces.find((f) => f.family === 'Space Grotesk')!.text).toBe('시');
    // labels use Inter 500: their text is there for the right subsets
    expect(faces.find((f) => key(f) === '500 Inter')!.text).toContain('Did it work?');
    // fonts that aren't bundled are left to the browser
    ed.doc.set({ ...first, label: { ...first.label!, fontFamily: 'Comic Sans MS', runs: undefined } });
    expect(facesUsed(ed.doc.all()).some((f) => f.family === 'Comic Sans MS')).toBe(false);
  });
});
