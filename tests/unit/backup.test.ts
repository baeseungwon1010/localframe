import { describe, expect, it } from 'vitest';
import { buildZip, crc32, readZip } from '../../src/engine/zip.ts';
import { backupDue } from '../../src/ui/backup.ts';
import type { FileMeta } from '../../shared/schema.ts';

const enc = new TextEncoder();
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** A one-entry ZIP with a deflated entry, as other tools write them. */
async function deflatedZip(name: string, data: Uint8Array): Promise<Uint8Array> {
  const packed = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const stored = await bytes(buildZip([{ name, data: packed }]));
  const v = new DataView(stored.buffer);
  // turn the stored entry into a deflated one: method, real crc and size, in both headers
  const cd = stored.length - 22 - (46 + name.length);
  for (const [at, crcAt, sizeAt] of [[8, 14, 22], [cd + 10, cd + 16, cd + 24]]) {
    v.setUint16(at, 8, true);
    v.setUint32(crcAt, crc32(data), true);
    v.setUint32(sizeAt, data.length, true);
  }
  return stored;
}

describe('backups', () => {
  it('reads back what the ZIP writer wrote, names and contents', async () => {
    const entries = [
      { name: 'a.localframe.json', data: enc.encode('{"a":1}') },
      { name: '한글 이름.localframe.json', data: enc.encode('{"b":2}') },
    ];
    const out = await readZip(await bytes(buildZip(entries)));
    expect(out.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(new TextDecoder().decode(out[1].data)).toBe('{"b":2}');
  });

  it('reads deflated entries from other tools', async () => {
    const text = 'compress me '.repeat(500);
    const out = await readZip(await deflatedZip('big.json', enc.encode(text)));
    expect(new TextDecoder().decode(out[0].data)).toBe(text);
  });

  it('a ZIP bomb (an entry inflating past its declared size) is refused without filling memory', async () => {
    const huge = new Uint8Array(20 * 1024 * 1024); // 20 MB of zeros packs into a few KB
    const zip = await deflatedZip('bomb.json', huge);
    // claim the entry is 10 bytes, in both headers
    const v = new DataView(zip.buffer);
    const cd = zip.length - 22 - (46 + 'bomb.json'.length);
    v.setUint32(22, 10, true);
    v.setUint32(cd + 24, 10, true);
    const before = process.memoryUsage().arrayBuffers;
    await expect(readZip(zip)).rejects.toThrow(/damaged/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 * 1024 * 1024);
  });

  it('refuses damaged, oversized or foreign archives', async () => {
    const zip = await bytes(buildZip([{ name: 'a.json', data: enc.encode('hello') }]));
    const bad = zip.slice();
    bad[30 + 'a.json'.length] ^= 0xff; // flip a byte of the content
    await expect(readZip(bad)).rejects.toThrow(/damaged/);
    await expect(readZip(enc.encode('not a zip at all'))).rejects.toThrow(/isn't a ZIP/);
    await expect(readZip(zip, { entries: 10, entryBytes: 2, totalBytes: 100 })).rejects.toThrow(/too large/);
    const many = await bytes(buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `${i}.json`, data: enc.encode('x') }))));
    await expect(readZip(many, { entries: 3, entryBytes: 100, totalBytes: 100 })).rejects.toThrow(/more than 3/);
  });

  it('reminds when work is over a day old and was never backed up', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const file = (created: string, updated: string) => ({ createdAt: created, updatedAt: updated }) as FileMeta;
    expect(backupDue([], now)).toBe(false);
    expect(backupDue([file('2026-10-15T08:00:00Z', '2026-10-15T09:00:00Z')], now)).toBe(false);
    expect(backupDue([file('2026-10-13T08:00:00Z', '2026-10-15T09:00:00Z')], now)).toBe(true);
  });
});
