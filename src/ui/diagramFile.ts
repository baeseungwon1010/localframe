import type { ExportedFile } from '../../shared/schema.ts';
import { EXPORT_FORMAT } from '../../shared/schema.ts';
import { loadFonts } from './hooks.ts';

/**
 * Diagram specs (docs/diagram-spec.md) in the app: a spec dropped on Import, pasted on the file
 * list or carried by a #/diagram/ link is drawn here into a file. The builder and the canvas
 * engine load only when one arrives.
 */

/** Whether imported JSON is a diagram spec rather than a localframe file. */
export function isDiagramSpec(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as { format?: unknown; nodes?: unknown };
  return d.format !== EXPORT_FORMAT && Array.isArray(d.nodes) && d.nodes.every((n) => typeof n === 'string' || (!!n && typeof n === 'object' && 'id' in n && !('type' in n)));
}

/** The file a spec draws. Throws an Error naming what's wrong with the spec. */
export async function fileFromSpec(spec: unknown): Promise<ExportedFile> {
  // words are measured to size the boxes: the faces must be there first
  const words = JSON.stringify(spec).slice(0, 20_000);
  const [{ buildDiagram }] = await Promise.all([
    import('../diagram/build.ts'),
    // the faces are declared by this CSS, so it comes before they're loaded
    import('./canvasFonts.ts').then(() => loadFonts(['Inter', 'Noto Sans KR'].flatMap((family) => [400, 500, 600, 700].map((weight) => ({ family, weight, text: words }))))),
  ]);
  return buildDiagram(spec).file;
}
