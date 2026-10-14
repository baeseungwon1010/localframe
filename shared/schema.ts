import { z } from 'zod';
import { generateKeyBetween } from 'fractional-indexing';

export const NODE_TYPES = ['FRAME', 'GROUP', 'BOOLEAN', 'COMPONENT_SET', 'COMPONENT', 'INSTANCE', 'RECTANGLE', 'ELLIPSE', 'VECTOR', 'LINE', 'TEXT'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const finite = z.number().finite();
export const IdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const id = IdSchema;
/** Images are stored by the SHA-256 of their bytes. */
export const ImageIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const MAX_DEPTH = 100;
export const MAX_NODES_PER_FILE = 100_000;
export const MAX_PAGES = 100;
/** Limits on what instances may expand to (see validateTree). */
export const MAX_EXPANDED_PER_COMPONENT = 200_000;
export const MAX_EXPANDED_PER_FILE = 1_000_000;
/** Coordinates beyond this are refused (and clamped by the editor). */
export const MAX_COORD = 1e8;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** An exported file carries its images, so imports may be larger than other requests. */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

/** A fractional-index order key the editor can insert next to. */
export function isValidOrderKey(key: string): boolean {
  if (!/^[A-Za-z][0-9A-Za-z]*$/.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

const orderKey = z.string().min(1).max(200).refine(isValidOrderKey, 'invalid order key');

export const SolidPaintSchema = z
  .object({
    type: z.literal('SOLID').optional(),
    color: hexColor,
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
  })
  .strict();

export const ImagePaintSchema = z
  .object({
    type: z.literal('IMAGE'),
    imageId: ImageIdSchema,
    scaleMode: z.enum(['fill', 'fit', 'stretch', 'crop']),
    /** Crop: zoom over "fill" and offset from the centre, in the layer's units. */
    crop: z.object({ x: z.number().min(-1e6).max(1e6), y: z.number().min(-1e6).max(1e6), scale: z.number().min(0.05).max(50) }).strict().optional(),
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
  })
  .strict();

const unitPoint = z.object({ x: z.number().min(-10).max(10), y: z.number().min(-10).max(10) }).strict();

export const GradientPaintSchema = z
  .object({
    type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL']),
    stops: z
      .array(z.object({ position: z.number().min(0).max(1), color: hexColor, opacity: z.number().min(0).max(1) }).strict())
      .min(2)
      .max(16),
    /** In the layer's unit box (0..1). Linear: start and end. Radial: centre and a point on the edge. */
    from: unitPoint,
    to: unitPoint,
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
  })
  .strict();

export const PaintSchema = z.union([ImagePaintSchema, GradientPaintSchema, SolidPaintSchema]);
export const StrokePaintSchema = z.union([GradientPaintSchema, SolidPaintSchema]);
export type SolidPaint = z.infer<typeof SolidPaintSchema>;
export type ImagePaint = z.infer<typeof ImagePaintSchema>;
export type GradientPaint = z.infer<typeof GradientPaintSchema>;
export type Paint = z.infer<typeof PaintSchema>;
export type StrokePaint = z.infer<typeof StrokePaintSchema>;
export const isImagePaint = (p: Paint): p is ImagePaint => p.type === 'IMAGE';
export const isGradientPaint = (p: Paint): p is GradientPaint => p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL';

const effectLen = z.number().min(-10_000).max(10_000);
export const ShadowEffectSchema = z
  .object({
    type: z.enum(['DROP_SHADOW', 'INNER_SHADOW']),
    color: hexColor,
    opacity: z.number().min(0).max(1),
    x: effectLen,
    y: effectLen,
    blur: z.number().min(0).max(1000),
    spread: z.number().min(-1000).max(1000),
    visible: z.boolean(),
  })
  .strict();
export const BlurEffectSchema = z
  .object({ type: z.enum(['LAYER_BLUR', 'BACKGROUND_BLUR']), radius: z.number().min(0).max(1000), visible: z.boolean() })
  .strict();
export const EffectSchema = z.union([ShadowEffectSchema, BlurEffectSchema]);
export type ShadowEffect = z.infer<typeof ShadowEffectSchema>;
export type BlurEffect = z.infer<typeof BlurEffectSchema>;
export type Effect = z.infer<typeof EffectSchema>;

export const TextRunSchema = z
  .object({
    start: z.number().int().min(0).max(100_000),
    end: z.number().int().min(0).max(100_000),
    fontFamily: z.string().min(1).max(100).optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    fontSize: z.number().min(1).max(2000).optional(),
    color: hexColor.optional(),
    italic: z.boolean().optional(),
    decoration: z.enum(['none', 'underline', 'strikethrough']).optional(),
  })
  .strict()
  .refine((r) => r.end > r.start, 'empty run');
export type TextRun = z.infer<typeof TextRunSchema>;

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
    italic: z.boolean().optional(),
    decoration: z.enum(['none', 'underline', 'strikethrough']).optional(),
    /** Ranges of the text with their own style (character offsets, end exclusive). */
    runs: z.array(TextRunSchema).max(2000).optional(),
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

const pad = z.number().min(0).max(10_000);

/** Auto layout on a frame or component. */
export const LayoutSchema = z
  .object({
    mode: z.enum(['horizontal', 'vertical']),
    gap: z.number().min(-10_000).max(10_000),
    padding: z.tuple([pad, pad, pad, pad]), // top, right, bottom, left
    primaryAlign: z.enum(['start', 'center', 'end', 'space-between']),
    crossAlign: z.enum(['start', 'center', 'end', 'stretch']),
    widthMode: z.enum(['fixed', 'hug']),
    heightMode: z.enum(['fixed', 'hug']),
    /** Horizontal layouts only: items flow onto new rows when a row is full. */
    wrap: z.boolean().optional(),
    /** Space between wrapped rows. */
    counterGap: z.number().min(0).max(10_000).optional(),
  })
  .strict();
export type Layout = z.infer<typeof LayoutSchema>;

/** How a child of an auto layout frame is sized and placed. */
export const LayoutChildSchema = z
  .object({
    horizontal: z.enum(['fixed', 'fill']),
    vertical: z.enum(['fixed', 'fill']),
    absolute: z.boolean(),
  })
  .strict();
export type LayoutChild = z.infer<typeof LayoutChildSchema>;

/** 'auto' picks the side that faces the other end of the line, every time either end moves. */
const vpt = z.object({ x: z.number().min(-1e8).max(1e8), y: z.number().min(-1e8).max(1e8) }).strict();
/** A path in the layer's own coordinates; `in` and `out` are absolute curve handles. */
export const VectorSchema = z
  .object({
    closed: z.boolean(),
    points: z.array(z.object({ x: vpt.shape.x, y: vpt.shape.y, in: vpt.optional(), out: vpt.optional() }).strict()).min(1).max(10_000),
  })
  .strict();
export type Vector = z.infer<typeof VectorSchema>;
export type VectorPoint = Vector['points'][number];

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const BOOLEAN_OPS = ['union', 'subtract', 'intersect', 'exclude'] as const;
export type BooleanOp = (typeof BOOLEAN_OPS)[number];

export const ANCHORS = ['top', 'right', 'bottom', 'left', 'auto'] as const;
export const BindingSchema = z.object({ nodeId: id, anchor: z.enum(ANCHORS) }).strict();
export type Binding = z.infer<typeof BindingSchema>;

export const OverrideSchema = z
  .object({
    characters: z.string().max(100_000).optional(),
    fills: z.array(PaintSchema).max(16).optional(),
    visible: z.boolean().optional(),
  })
  .strict();
export type Override = z.infer<typeof OverrideSchema>;

const shortText = z.string().min(1).max(100);

/** A component property: text that instances can change, or a boolean that shows or hides layers. */
export const ComponentPropSchema = z.union([
  z.object({ id, name: shortText, type: z.literal('TEXT'), defaultValue: z.string().max(10_000) }).strict(),
  z.object({ id, name: shortText, type: z.literal('BOOLEAN'), defaultValue: z.boolean() }).strict(),
]);
export type ComponentProp = z.infer<typeof ComponentPropSchema>;

/** Font settings a text style carries (not the text itself, alignment or resizing). */
export const TextStyleValueSchema = z
  .object({
    fontFamily: z.string().min(1).max(100),
    fontWeight: z.number().int().min(100).max(900),
    fontSize: z.number().min(1).max(2000),
    lineHeight: z.number().min(0).max(4000).nullable(),
    letterSpacing: z.number().min(-200).max(2000),
  })
  .strict();
export type TextStyleValue = z.infer<typeof TextStyleValueSchema>;

export const StyleSchema = z.union([
  z.object({ id, name: z.string().trim().min(1).max(200), type: z.literal('FILL'), value: z.array(PaintSchema).min(1).max(16) }).strict(),
  z.object({ id, name: z.string().trim().min(1).max(200), type: z.literal('TEXT'), value: TextStyleValueSchema }).strict(),
  z.object({ id, name: z.string().trim().min(1).max(200), type: z.literal('EFFECT'), value: z.array(EffectSchema).min(1).max(8) }).strict(),
]);
export type Style = z.infer<typeof StyleSchema>;
export const StylesSchema = z
  .array(StyleSchema)
  .max(500)
  .refine((list) => new Set(list.map((x) => x.id)).size === list.length, 'duplicate style id');

export const VariableSchema = z
  .object({
    id,
    collectionId: id,
    name: z.string().trim().min(1).max(200),
    type: z.enum(['COLOR', 'NUMBER']),
    values: z.record(id, z.union([hexColor, z.number().min(-1e7).max(1e7)])),
  })
  .strict()
  .refine((v) => Object.values(v.values).every((x) => (v.type === 'COLOR' ? typeof x === 'string' : typeof x === 'number')), 'value type');
export type Variable = z.infer<typeof VariableSchema>;

export const VariablesSchema = z
  .object({
    collections: z
      .array(
        z
          .object({
            id,
            name: z.string().trim().min(1).max(200),
            modes: z.array(z.object({ id, name: z.string().trim().min(1).max(100) }).strict()).min(1).max(20),
          })
          .strict(),
      )
      .max(50),
    vars: z.array(VariableSchema).max(2000),
  })
  .strict()
  .refine((v) => {
    const ids = new Set(v.collections.map((c) => c.id));
    return ids.size === v.collections.length && v.vars.every((x) => ids.has(x.collectionId)) && new Set(v.vars.map((x) => x.id)).size === v.vars.length;
  }, 'variables must belong to existing collections');
export type Variables = z.infer<typeof VariablesSchema>;
export const EMPTY_VARIABLES: Variables = { collections: [], vars: [] };

export const BINDABLE = ['fill', 'stroke', 'radius', 'gap', 'padding', 'strokeWeight', 'opacity'] as const;
export type Bindable = (typeof BINDABLE)[number];

export const LayoutGridSchema = z
  .object({
    type: z.enum(['columns', 'rows', 'grid']),
    count: z.number().int().min(1).max(100),
    gutter: z.number().min(0).max(1000),
    margin: z.number().min(0).max(10_000),
    /** Cell size of a square grid. */
    size: z.number().min(1).max(1000),
    color: hexColor,
    opacity: z.number().min(0).max(1),
    visible: z.boolean(),
  })
  .strict();
export type LayoutGrid = z.infer<typeof LayoutGridSchema>;

export const GuideSchema = z.object({ axis: z.enum(['x', 'y']), pos: z.number().min(-1e8).max(1e8) }).strict();
export type PageGuide = z.infer<typeof GuideSchema>;

// ------------------------------------------------------------- prototyping

export const TRIGGERS = ['click', 'mouse-enter', 'after-delay'] as const;
export const ACTIONS = ['navigate', 'back', 'overlay', 'close-overlay'] as const;
export const TRANSITIONS = ['instant', 'dissolve', 'move-in', 'push', 'slide-in'] as const;
export const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
export const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const;

/** What happens in a presentation when a layer is clicked, hovered, or a frame has been shown a while. */
export const ReactionSchema = z
  .object({
    trigger: z.enum(TRIGGERS),
    /** after-delay: milliseconds */
    delay: z.number().int().min(0).max(60_000).optional(),
    action: z.enum(ACTIONS),
    /** navigate and overlay: a top-level frame */
    destinationId: id.optional(),
    transition: z.enum(TRANSITIONS),
    direction: z.enum(DIRECTIONS).optional(),
    duration: z.number().int().min(0).max(10_000),
    easing: z.enum(EASINGS),
  })
  .strict();
export type Reaction = z.infer<typeof ReactionSchema>;

export const SceneNodeSchema = z
  .object({
    id,
    type: z.enum(NODE_TYPES),
    parentId: id.nullable(),
    /** Page of a top-level node. Missing means the first page. Children inherit their parent's page. */
    pageId: id.optional(),
    order: orderKey,
    name: z.string().min(1).max(500),
    visible: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().min(0).max(1),
    // Local transform: translate(x, y) then rotate(rotation) about that origin.
    x: z.number().min(-MAX_COORD).max(MAX_COORD),
    y: z.number().min(-MAX_COORD).max(MAX_COORD),
    width: z.number().min(0).max(1e7),
    height: z.number().min(0).max(1e7),
    rotation: z.number().min(-360).max(360),
    fills: z.array(PaintSchema).max(16),
    strokes: z.array(StrokePaintSchema).max(16),
    effects: z.array(EffectSchema).max(8).optional(),
    strokeWeight: z.number().min(0).max(1000),
    strokeAlign: z.enum(['inside', 'center', 'outside']),
    strokeDash: z.array(z.number().min(0).max(1000)).max(8),
    radii: z.tuple([finite, finite, finite, finite]).optional(),
    clipsContent: z.boolean().optional(),
    constraints: ConstraintsSchema.optional(),
    layout: LayoutSchema.optional(),
    grids: z.array(LayoutGridSchema).max(8).optional(),
    layoutChild: LayoutChildSchema.optional(),
    arrowStart: z.boolean().optional(),
    arrowEnd: z.boolean().optional(),
    startBind: BindingSchema.optional(),
    endBind: BindingSchema.optional(),
    /** Connector drawn with right-angle bends; `route` holds the bends in the line's own coordinates. */
    elbow: z.boolean().optional(),
    route: z.array(z.object({ x: finite, y: finite }).strict()).max(8).optional(),
    text: TextStyleSchema.optional(),
    vector: VectorSchema.optional(),
    booleanOp: z.enum(BOOLEAN_OPS).optional(),
    /** Clips the layers above it in the same parent. */
    isMask: z.boolean().optional(),
    reactions: z.array(ReactionSchema).max(20).optional(),
    /** Size limits applied by auto layout (to a hugging frame, and to its children). */
    minWidth: z.number().min(0).max(1e6).optional(),
    maxWidth: z.number().min(0).max(1e6).optional(),
    minHeight: z.number().min(0).max(1e6).optional(),
    maxHeight: z.number().min(0).max(1e6).optional(),
    /** How the layer mixes with what is below it (CSS blend mode names). */
    blendMode: z.enum(BLEND_MODES).optional(),
    fillStyleId: id.optional(),
    strokeStyleId: id.optional(),
    textStyleId: id.optional(),
    effectStyleId: id.optional(),
    /** Properties driven by variables: property -> variable id. */
    bindings: z.partialRecord(z.enum(BINDABLE), id).optional(),
    /** Variable modes chosen on this layer for its content: collection id -> mode id. */
    modes: z
      .record(id, id)
      .refine((m) => Object.keys(m).length <= 50, 'too many modes')
      .optional(),
    /** Variant values of a component inside a component set, e.g. { Size: 'Large' }. */
    variant: z
      .record(shortText, z.string().max(100))
      .refine((v) => Object.keys(v).length <= 20, 'too many variant properties')
      .optional(),
    componentProps: z.array(ComponentPropSchema).max(50).optional(),
    /** Links this layer's text or visibility to a property of its component. */
    propRefs: z.object({ characters: id.optional(), visible: id.optional() }).strict().optional(),
    /** An instance's values for its component's properties. */
    propValues: z
      .record(id, z.union([z.string().max(10_000), z.boolean()]))
      .refine((v) => Object.keys(v).length <= 50, 'too many property values')
      .optional(),
    componentId: id.optional(),
    overrides: z
      .record(id, OverrideSchema)
      .refine((o) => Object.keys(o).length <= 2000, 'too many overrides')
      .optional(),
  })
  .strict()
  .superRefine((n, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const container = n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET';
    if (n.type === 'GROUP' && (n.fills.length || n.strokes.length || n.clipsContent || n.layout))
      issue('groups have no fills, strokes, clipping or auto layout');
    if ((n.type === 'VECTOR') !== (n.vector !== undefined)) issue('VECTOR needs vector');
    if ((n.type === 'BOOLEAN') !== (n.booleanOp !== undefined)) issue('BOOLEAN needs booleanOp');
    if (n.type === 'BOOLEAN' && (n.clipsContent || n.layout)) issue('booleans have no clipping or auto layout');
    if (n.type === 'TEXT' && !n.text) issue('TEXT needs text');
    if (n.type !== 'TEXT' && n.text) issue('only TEXT has text');
    if (!container && n.type !== 'INSTANCE' && n.clipsContent !== undefined) issue('only frames have clipsContent');
    if (!container && n.layout) issue('only frames have auto layout');
    if (!container && n.grids) issue('only frames have layout grids');
    if (n.type !== 'LINE' && (n.arrowStart !== undefined || n.arrowEnd !== undefined)) issue('only LINE has arrows');
    if (n.type !== 'LINE' && (n.startBind || n.endBind)) issue('only LINE has bindings');
    if (n.type !== 'LINE' && (n.elbow !== undefined || n.route)) issue('only LINE has elbows');
    if ((n.type === 'INSTANCE') !== (n.componentId !== undefined)) issue('INSTANCE needs componentId');
    if (n.type !== 'INSTANCE' && n.overrides) issue('only INSTANCE has overrides');
    if (n.type !== 'INSTANCE' && n.propValues) issue('only INSTANCE has property values');
    if (n.type !== 'COMPONENT' && n.variant) issue('only components have variant values');
    if (n.componentProps && n.type !== 'COMPONENT' && n.type !== 'COMPONENT_SET') issue('only components have properties');
    if (n.parentId === n.id) issue('node cannot be its own parent');
    if (n.parentId !== null && n.pageId !== undefined) issue('only top-level layers have a page');
  });
export type SceneNode = z.infer<typeof SceneNodeSchema>;

/** Types whose children are stored layers. */
export const isContainerType = (t: NodeType) =>
  t === 'FRAME' || t === 'COMPONENT' || t === 'COMPONENT_SET' || t === 'GROUP' || t === 'BOOLEAN';
/** Containers whose box always fits their children. */
export const fitsChildren = (t: NodeType) => t === 'GROUP' || t === 'BOOLEAN';
/** Containers that are frames (own box, fills, clipping, auto layout, drop target). */
export const isFrameLike = (t: NodeType) => t === 'FRAME' || t === 'COMPONENT' || t === 'COMPONENT_SET';

export const PageSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(200),
    background: hexColor,
    guides: z.array(GuideSchema).max(200).optional(),
    /** The frame a presentation of this page starts on. */
    prototypeStart: id.optional(),
  })
  .strict();
export type Page = z.infer<typeof PageSchema>;

export const PagesSchema = z
  .array(PageSchema)
  .min(1)
  .max(MAX_PAGES)
  .refine((pages) => new Set(pages.map((p) => p.id)).size === pages.length, 'duplicate page id');

export const FileMetaSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    background: hexColor,
    pages: PagesSchema,
    styles: StylesSchema,
    variables: VariablesSchema,
    version: z.number().int().min(0),
    createdAt: z.string(),
    updatedAt: z.string(),
    hasThumbnail: z.boolean(),
  })
  .strict();
export type FileMeta = z.infer<typeof FileMetaSchema>;

export const CreateFileSchema = z.object({ name: z.string().trim().min(1).max(200).optional() }).strict();
export const UpdateFileSchema = z.object({ name: z.string().trim().min(1).max(200).optional() }).strict();

// ------------------------------------------------------------ versions and comments

export type VersionMeta = { id: number; name: string | null; auto: boolean; createdAt: string; nodeCount: number };
export const VersionNameSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

export const MAX_COMMENTS_PER_FILE = 5000;
const coord = z.number().min(-1e7).max(1e7);
const commentBody = z.string().trim().min(1).max(5000);

/**
 * A comment pin (or a reply, which has a parentId). x/y are on the page; a pin on a layer also has
 * its place inside that layer (`offset`), so it moves with it, and falls back to x/y once it's gone.
 */
export type Comment = {
  id: string;
  parentId: string | null;
  pageId: string;
  nodeId: string | null;
  offset: { x: number; y: number } | null;
  x: number;
  y: number;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
};
const commentOffset = z.object({ x: coord, y: coord }).strict();
export const NewCommentSchema = z
  .object({
    parentId: IdSchema.optional(),
    pageId: IdSchema,
    nodeId: IdSchema.optional(),
    offset: commentOffset.optional(),
    x: coord,
    y: coord,
    body: commentBody,
  })
  .strict()
  .refine((c) => !c.nodeId === !c.offset, 'a pin on a layer needs its offset');
export const CommentPatchSchema = z
  .object({
    body: commentBody.optional(),
    resolved: z.boolean().optional(),
    x: coord.optional(),
    y: coord.optional(),
    nodeId: IdSchema.nullable().optional(),
    offset: commentOffset.nullable().optional(),
  })
  .strict()
  .refine((c) => c.nodeId === undefined || !c.nodeId === !c.offset, 'a pin on a layer needs its offset');

export const ChangesSchema = z
  .object({
    baseVersion: z.number().int().min(0),
    upserts: z.array(SceneNodeSchema).max(50_000),
    deletes: z.array(id).max(50_000),
    pages: PagesSchema.optional(),
    styles: StylesSchema.optional(),
    variables: VariablesSchema.optional(),
  })
  .strict();
export type Changes = z.infer<typeof ChangesSchema>;

export const ThumbnailSchema = z
  .object({ dataUrl: z.string().max(400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/) })
  .strict();

export const EXPORT_FORMAT = 'localframe-file';
export const EXPORT_VERSION = 2;

export const ExportedImageSchema = z
  .object({
    id: ImageIdSchema,
    mime: z.enum(IMAGE_TYPES),
    data: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/=]*$/),
  })
  .strict();

export const ExportedFileSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(2)]),
    name: z.string().trim().min(1).max(200),
    background: hexColor,
    pages: PagesSchema.optional(),
    styles: StylesSchema.optional(),
    variables: VariablesSchema.optional(),
    nodes: z.array(SceneNodeSchema).max(MAX_NODES_PER_FILE),
    images: z.array(ExportedImageSchema).max(500).optional(),
  })
  .strict();
export type ExportedFile = z.infer<typeof ExportedFileSchema>;

/** Recognises image bytes by their signature; SVG and anything else is refused. */
export function sniffImage(bytes: Uint8Array): (typeof IMAGE_TYPES)[number] | null {
  const b = (i: number) => bytes[i];
  if (bytes.length > 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (bytes.length > 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && String.fromCharCode(b(0), b(1), b(2), b(3)) === 'RIFF' && String.fromCharCode(b(8), b(9), b(10), b(11)) === 'WEBP')
    return 'image/webp';
  if (bytes.length > 6) {
    const sig = String.fromCharCode(b(0), b(1), b(2), b(3), b(4), b(5));
    if (sig === 'GIF89a' || sig === 'GIF87a') return 'image/gif';
  }
  return null;
}

/**
 * Checks that need all nodes at once: unique ids, parents exist, only frames and components have children,
 * no cycles, nesting at most MAX_DEPTH, top-level layers on known pages, and no component that contains an
 * instance of itself (directly or through other components). Linear in the number of nodes.
 */
export function validateTree(nodes: Iterable<SceneNode>, pages?: Page[]): string | null {
  const byId = new Map<string, SceneNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) return `duplicate id ${n.id}`;
    byId.set(n.id, n);
  }
  if (byId.size > MAX_NODES_PER_FILE) return `more than ${MAX_NODES_PER_FILE} layers`;
  const pageIds = pages ? new Set(pages.map((p) => p.id)) : null;
  const depth = new Map<string, number>(); // finished nodes
  // nearest component ancestor of each finished node (null = none)
  const owner = new Map<string, string | null>();
  for (const start of byId.values()) {
    if (depth.has(start.id)) continue;
    // Walk up until a node with a known depth (or the page), then fill the path in.
    const path: SceneNode[] = [];
    const onPath = new Set<string>();
    let cur: SceneNode | undefined = start;
    let base = -1;
    let baseOwner: string | null = null;
    while (cur) {
      const known = depth.get(cur.id);
      if (known !== undefined) {
        base = known;
        baseOwner = cur.type === 'COMPONENT' ? cur.id : (owner.get(cur.id) ?? null);
        break;
      }
      if (onPath.has(cur.id)) return `cycle at ${cur.id}`;
      onPath.add(cur.id);
      path.push(cur);
      if (cur.parentId === null) {
        if (pageIds && cur.pageId !== undefined && !pageIds.has(cur.pageId)) return `node ${cur.id} is on a missing page`;
        break;
      }
      const parent = byId.get(cur.parentId);
      if (!parent) return `node ${cur.id} has a missing parent`;
      if (!isContainerType(parent.type)) return `node ${cur.id} is inside a ${parent.type.toLowerCase()}`;
      if (parent.type === 'COMPONENT_SET' && cur.type !== 'COMPONENT') return `a component set can only hold components`;
      cur = parent;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      base += 1;
      if (base >= MAX_DEPTH) return `layers are nested more than ${MAX_DEPTH} deep`;
      depth.set(path[i].id, base);
      owner.set(path[i].id, baseOwner);
      if (path[i].type === 'COMPONENT') baseOwner = path[i].id;
    }
  }
  // Component graph. An edge A -> B means drawing A also draws B: B is nested inside A, or an
  // instance of B is inside A. Instance edges repeat once per instance, for the size estimate below.
  const edges = new Map<string, string[]>();
  const direct = new Map<string, number>(); // layers whose nearest component is this one
  const addEdge = (a: string, b: string) => {
    const list = edges.get(a);
    if (list) list.push(b);
    else edges.set(a, [b]);
  };
  const instanceTargets: string[] = [];
  for (const n of byId.values()) {
    const own = owner.get(n.id) ?? null;
    if (own) direct.set(own, (direct.get(own) ?? 0) + 1);
    if (n.type === 'COMPONENT' && own) addEdge(own, n.id);
    if (n.type === 'INSTANCE' && n.componentId) {
      const target = byId.get(n.componentId);
      if (target && target.type !== 'COMPONENT') return `instance ${n.id} points at a ${target.type.toLowerCase()}`;
      if (own) addEdge(own, n.componentId);
      instanceTargets.push(n.componentId);
    }
  }
  // cycles (iterative DFS)
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const order: string[] = []; // post-order: every component after the ones it uses
  for (const startId of edges.keys()) {
    if (state.get(startId) === 2) continue;
    const stack: [string, number][] = [[startId, 0]];
    state.set(startId, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = edges.get(top[0]) ?? [];
      if (top[1] >= list.length) {
        state.set(top[0], 2);
        order.push(top[0]);
        stack.pop();
        continue;
      }
      const next = list[top[1]++];
      const st = state.get(next);
      if (st === 1) return `component ${next} contains an instance of itself`;
      if (st === undefined) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
  // How many layers drawing each component produces once instances are expanded. Nested instances
  // multiply, so a small file could otherwise expand to billions of layers.
  const expanded = new Map<string, number>();
  for (const cid of order) {
    let total = direct.get(cid) ?? 0;
    for (const t of edges.get(cid) ?? []) total += expanded.get(t) ?? direct.get(t) ?? 0;
    if (total > MAX_EXPANDED_PER_COMPONENT) return `component ${cid} expands to more than ${MAX_EXPANDED_PER_COMPONENT} layers`;
    expanded.set(cid, total);
  }
  let all = 0;
  for (const t of instanceTargets) {
    all += expanded.get(t) ?? direct.get(t) ?? 0;
    if (all > MAX_EXPANDED_PER_FILE) return `instances in this file expand to more than ${MAX_EXPANDED_PER_FILE} layers`;
  }
  return null;
}
