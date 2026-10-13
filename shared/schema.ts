import { z } from 'zod';

export const NODE_TYPES = ['FRAME', 'RECTANGLE', 'ELLIPSE', 'LINE', 'TEXT'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const finite = z.number().finite();
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const PaintSchema = z
  .object({
    color: hexColor,
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
  })
  .strict();
export type Paint = z.infer<typeof PaintSchema>;

export const TextStyleSchema = z
  .object({
    characters: z.string().max(100_000),
    fontFamily: z.string().min(1).max(100),
    fontWeight: z.number().int().min(100).max(900),
    fontSize: z.number().min(1).max(2000),
    lineHeight: z.number().min(0).max(4000).nullable(), // px; null = auto (1.2 x size)
    letterSpacing: z.number().min(-200).max(2000), // px
    align: z.enum(['left', 'center', 'right']),
    autoResize: z.enum(['width', 'height', 'none']),
  })
  .strict();
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const ConstraintsSchema = z
  .object({
    horizontal: z.enum(['left', 'right', 'leftRight', 'center', 'scale']),
    vertical: z.enum(['top', 'bottom', 'topBottom', 'center', 'scale']),
  })
  .strict();
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const SceneNodeSchema = z
  .object({
    id,
    type: z.enum(NODE_TYPES),
    parentId: id.nullable(),
    order: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    visible: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0).max(1),
    // Local transform: translate(x, y) then rotate(rotation) about that origin.
    x: finite,
    y: finite,
    width: z.number().min(0).max(1e7),
    height: z.number().min(0).max(1e7),
    rotation: z.number().min(-360).max(360),
    fills: z.array(PaintSchema).max(16),
    strokes: z.array(PaintSchema).max(16),
    strokeWeight: z.number().min(0).max(1000),
    strokeAlign: z.enum(['inside', 'center', 'outside']),
    strokeDash: z.array(z.number().min(0).max(1000)).max(8),
    radii: z.tuple([finite, finite, finite, finite]).optional(),
    clipsContent: z.boolean().optional(),
    constraints: ConstraintsSchema.optional(),
    arrowStart: z.boolean().optional(),
    arrowEnd: z.boolean().optional(),
    text: TextStyleSchema.optional(),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.type === 'TEXT' && !n.text) ctx.addIssue({ code: 'custom', message: 'TEXT needs text' });
    if (n.type !== 'TEXT' && n.text) ctx.addIssue({ code: 'custom', message: 'only TEXT has text' });
    if (n.type !== 'FRAME' && n.clipsContent !== undefined)
      ctx.addIssue({ code: 'custom', message: 'only FRAME has clipsContent' });
    if (n.type !== 'LINE' && (n.arrowStart !== undefined || n.arrowEnd !== undefined))
      ctx.addIssue({ code: 'custom', message: 'only LINE has arrows' });
    if (n.parentId === n.id) ctx.addIssue({ code: 'custom', message: 'node cannot be its own parent' });
  });
export type SceneNode = z.infer<typeof SceneNodeSchema>;

export const FileMetaSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    background: hexColor,
    version: z.number().int().min(0),
    createdAt: z.string(),
    updatedAt: z.string(),
    hasThumbnail: z.boolean(),
  })
  .strict();
export type FileMeta = z.infer<typeof FileMetaSchema>;

export const CreateFileSchema = z.object({ name: z.string().trim().min(1).max(200).optional() }).strict();
export const UpdateFileSchema = z
  .object({ name: z.string().trim().min(1).max(200).optional(), background: hexColor.optional() })
  .strict();

export const ChangesSchema = z
  .object({
    baseVersion: z.number().int().min(0),
    upserts: z.array(SceneNodeSchema).max(50_000),
    deletes: z.array(id).max(50_000),
  })
  .strict();
export type Changes = z.infer<typeof ChangesSchema>;

export const ThumbnailSchema = z
  .object({ dataUrl: z.string().max(400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/) })
  .strict();

export const EXPORT_FORMAT = 'localframe-file';
export const EXPORT_VERSION = 1;

export const ExportedFileSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    name: z.string().min(1).max(200),
    background: hexColor,
    nodes: z.array(SceneNodeSchema).max(50_000),
  })
  .strict();
export type ExportedFile = z.infer<typeof ExportedFileSchema>;

/** Tree checks that need all nodes at once: parents exist, only frames have children, no cycles. */
export function validateTree(nodes: Iterable<SceneNode>): string | null {
  const byId = new Map<string, SceneNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) return `duplicate id ${n.id}`;
    byId.set(n.id, n);
  }
  for (const n of byId.values()) {
    if (n.parentId === null) continue;
    const parent = byId.get(n.parentId);
    if (!parent) return `node ${n.id} has a missing parent`;
    if (parent.type !== 'FRAME') return `node ${n.id} is inside a ${parent.type.toLowerCase()}`;
    const seen = new Set<string>([n.id]);
    let cur: SceneNode | undefined = parent;
    while (cur) {
      if (seen.has(cur.id)) return `cycle at ${cur.id}`;
      seen.add(cur.id);
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
  }
  return null;
}
