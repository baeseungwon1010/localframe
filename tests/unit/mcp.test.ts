import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExportedFileSchema } from '../../shared/schema.ts';

/** Talks to the MCP server the way a client does: JSON-RPC, one message per line. */
function server() {
  const p = spawn(process.execPath, ['scripts/mcp.ts'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiting = new Map<number, (m: { result?: any; error?: any }) => void>();
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const call = (method: string, params: object = {}) =>
    new Promise<{ result?: any; error?: any }>((r) => {
      const id = ++n;
      waiting.set(id, r);
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { call, close: () => p.stdin.end() };
}

describe('the MCP server', () => {
  it('lists its tools, explains a bad spec and saves a good one', async () => {
    const s = server();
    try {
      const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect((await s.call('tools/list')).result.tools.map((t: { name: string }) => t.name)).toEqual(['diagram_guide', 'diagram_render', 'diagram_save']);
      expect((await s.call('tools/call', { name: 'diagram_guide', arguments: {} })).result.content[0].text).toMatch(/Lint codes/);

      const bad = await s.call('tools/call', { name: 'diagram_save', arguments: { spec: { nodes: ['a'], edges: ['a -> b'] } } });
      expect(bad.result.isError).toBe(true);
      expect(bad.result.content[0].text).toMatch(/no node "b"/);

      const path = join(mkdtempSync(join(tmpdir(), 'lf-mcp-')), 'flow');
      const saved = await s.call('tools/call', { name: 'diagram_save', arguments: { spec: { nodes: ['a: Ask', 'b: Answer'], edges: ['a -> b'] }, path, picture: false } });
      expect(saved.result.structuredContent.files).toEqual([`${path}.localframe.json`]);
      expect(ExportedFileSchema.safeParse(JSON.parse(readFileSync(`${path}.localframe.json`, 'utf8'))).success).toBe(true);

      expect((await s.call('no/such/method')).error.code).toBe(-32601);
    } finally {
      s.close();
    }
  }, 20_000);
});
