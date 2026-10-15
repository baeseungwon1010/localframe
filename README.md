# localframe

A local-first canvas design editor. Draw frames, shapes, connectors and text on an infinite canvas, place
images, build components and auto layout, organise everything in pages and layers, and export PNG, JPG,
WebP, SVG, PDF or a portable file. Everything runs on your machine: no account, no cloud, no third-party
requests.

## Try it

Open **https://baeseungwon1010.github.io/localframe/** to use it in your browser, with nothing to install
and no account. The web version keeps your files in your browser's own storage on your device: nothing is
uploaded, and other people can't see them. Clearing the site's data removes them, so export files you want
to keep. For a copy that keeps files on disk, run it locally (below).

## Features

- **Getting around**: quick actions (Ctrl/Cmd+/ or Ctrl/Cmd+K) find and run any command and show its
  shortcut; tools are grouped in the toolbar; a tip at the bottom of the canvas explains the tool in use;
  properties sections fold away; "Sample file" opens a finished design to explore.
- **Files**: create, rename, delete, import and export. Every change autosaves to a local SQLite file, and
  each file shows a thumbnail in the file list.
- **Version history**: name a version of the file at any point. The file is also saved there on its own
  when you start editing again after ten minutes away. Restoring a version keeps the current state as an
  autosave, so a restore can be undone.
- **Pages**: add, rename, duplicate, reorder and delete pages. Each page has its own background, and layers
  can be moved to another page.
- **Canvas**: infinite canvas with pan and zoom (Space-drag, scroll, Ctrl/Cmd+scroll or pinch), zoom to fit or
  to the selection, rulers with draggable guides, and light and dark themes.
- **Draw**:
  - frames (with presets for phones, tablets, desktops and paper), groups and nested frames with clip content
  - sections (Shift+S) that hold frames; drawing one around frames takes them in
  - rectangles with per-corner radius, ellipses, polygons, stars, lines and arrows
  - vector paths with the pen tool (P), edited point by point, and freehand lines with the pencil (Shift+P)
  - slices (S): areas of the page to export, never drawn in the design
  - text with auto width, auto height or a fixed size, and bold, italic, underline, a link, or a
    different font, size or colour on part of the text; bulleted and numbered lists, paragraph
    spacing, upper/lower/title case, small caps, kerning on or off, and a maximum number of lines;
    fonts installed on your computer
  Shift keeps proportions or 45° angles, and Alt draws from the centre.
- **Edit**:
  - Select, Shift-select and marquee. Double-click goes deeper, and Ctrl/Cmd-click selects the deepest layer.
  - Move with smart guides and snapping, nudge with the arrow keys, and Alt-drag to duplicate.
  - Resize with 8 handles and snapping, rotate one or several layers, and drag layers into or out of frames.
  - Undo and redo, copy, cut, paste (also between tabs and between files), duplicate, delete and z-order.
  - Group, wrap in a frame, ungroup, align, distribute, and rename many layers at once.
  - Hold Alt to see the distances from the selection to the layer under the pointer, or to its parent.
  - Select matching layers (Ctrl/Cmd+Alt+A), and find and replace text on the page (Ctrl/Cmd+F).
  - Boolean operations (union, subtract, intersect, exclude) and masks.
  - Flatten (Ctrl/Cmd+E) turns a rectangle, ellipse, polygon, star, line or boolean group into an
    editable vector; Outline stroke (Ctrl/Cmd+Shift+O) turns a stroke into a filled shape.
- **Images**: place PNG, JPEG, WebP or GIF images with the picker (Ctrl/Cmd+Shift+K), by dropping files on
  the canvas, or by pasting. An image fills its shape: fill, fit, stretch, or crop (double-click the
  image to move it inside its shape, and set the zoom in the panel).
- **Components**: components, instances, variants (Ctrl/Cmd+Alt+Shift+K combines components into a set),
  text, boolean and instance swap component properties, and overrides. Double-click into an instance to
  change one of its layers. Instances can be detached (Ctrl/Cmd+Alt+B).
- **Styles and variables**: colour, text and effect styles shared across the file; colour and number
  variables, and string and boolean ones, in collections with modes (for example light and dark, or
  English and Korean), bound to fills, strokes, radius, spacing, opacity, text and visibility.
- **Libraries**: use the components of another file on this computer. Inserting one copies it onto a
  "Library components" page; when the library file changes, the Assets tab offers to update the copies.
- **Auto layout and layout grids**: Shift+A stacks a frame's content vertically or horizontally, with gap,
  padding, alignment, and hug, fill or fixed sizes; or as a grid of equal columns. Horizontal layouts
  can wrap onto new rows, and
  minimum and maximum sizes limit how far a frame or child grows or shrinks.
- **Strokes**: inside, center or outside; dashed; flat, round or square ends; miter, round or bevel
  corners; a different weight per side on rectangles and frames. Frames can show column, row and square grids.
- **Paint and effects**: solid colours; linear, radial, angular and diamond gradients; images that fill,
  fit, stretch, crop or tile, with exposure, contrast and saturation; drop and inner shadows, layer,
  background and progressive blur, and noise; layer blend modes (multiply, screen, overlay and the rest).
- **Connectors**: a line or arrow drawn from one shape to another attaches to both and follows them when
  they move. Lines can be straight or elbow (right-angled). Dropping an end on a side's midpoint pins it to
  that side; Ctrl/Cmd while drawing leaves the ends loose.
- **Diagrams (like FigJam)**: sticky notes (N), rounded boxes, diamonds, parallelograms, cylinders,
  documents and chevrons in soft colours. Double-click a shape or connector (or press Enter) to write in
  it; the "+" on a selected shape's sides adds the next shape with an elbow arrow; a colour bar above
  diagram items recolours them. **Diagram mode** (the Design / Diagram switch in the title bar) hides the
  panels and puts the board tools in a dock at the bottom; each file remembers its mode in the browser.
  An empty board offers templates (flowchart, brainstorm, retrospective); sticky notes and shapes grow
  to hold their text; stamps (E) drop votes and reactions; connector text always stays upright.
- **Prototyping**: in the Prototype tab, make a layer open another frame on click, on mouse enter or after a
  delay, go back, open and close an overlay, change a component to another variant, or switch a variable
  mode, with instant, dissolve, smart animate, move in, push or slide in animations. Frames can scroll,
  with layers that stay fixed. Present (Ctrl/Cmd+Alt+Enter) plays the page full screen, optionally in a
  phone, tablet or desktop frame; clicking outside a link shows where the links are.
- **Comments**: the comment tool (C) pins a comment anywhere, or to a layer so it moves with it. Threads have
  replies and can be resolved, edited, moved and deleted. Comments stay on your machine.
- **Properties**: position, rotation, size with aspect lock, corner radius, constraints, opacity, fills and
  strokes (colour, opacity, weight, inside/center/outside, dashed), arrow heads and text settings. Fields
  accept maths, like `120/2`.
- **Layers panel**: tree view with search, rename, hide, lock, drag to reorder or reparent, and keyboard
  navigation.
- **Export a selection or page**: PNG, JPG, WebP (1x to 4x), SVG, PDF, or a vector PDF through the print
  dialog. Layers can keep their own export settings (formats, sizes and file name suffixes).
- **Code**: the Code tab shows CSS for the selected layer, with auto layout as flexbox.
- **View**: outline mode (Ctrl/Cmd+Y), pixel grid, snapping to whole pixels, and pixel preview.
- **Export a whole file** (Ctrl/Cmd+Shift+E, or the file list menu):
  - as a `.localframe.json` that keeps everything editable, images included;
  - as a PDF with one page per frame, as images (PNG, JPG or WebP) or as a vector PDF through the print
    dialog;
  - with every layer's saved export settings;
  - as SVG files, one per frame. Several files come in a ZIP, with a folder per page.
  - SVG exports embed their images and the font subsets they use, so they look the same anywhere.
- **Fonts**: Inter, IBM Plex Sans, IBM Plex Serif and Space Grotesk, with Noto Sans KR for Korean.
  All fonts are bundled.

## Requirements

Node.js 22.18 or newer (24 LTS recommended). The server uses the built-in `node:sqlite` and runs TypeScript
directly, so there is no native build step.

## Run it

```bash
git clone https://github.com/baeseungwon1010/localframe.git
cd localframe
npm install
npm run dev
```

Open http://localhost:5173.

For a production build served by the local server on one port:

```bash
npm run build
npm start
```

Open http://localhost:5174.

Data is stored in `data/localframe.db`, which git ignores. You can set `LOCALFRAME_DATA_DIR` to keep it
elsewhere and `LOCALFRAME_API_PORT` to change the port. Back up a file with **Export file** in the file list.

## Shortcuts

| Action | Keys |
| --- | --- |
| Move, Frame, Rectangle, Ellipse, Line, Pen, Text, Hand, Comment | V, F, R, O, L, P, T, H, C |
| Quick actions | Ctrl/Cmd+/ or Ctrl/Cmd+K |
| Sticky note / write in a shape | N / double-click or Enter |
| Section / Slice / Pencil | Shift+S / S / Shift+P |
| Flatten / Outline stroke | Ctrl/Cmd+E / Ctrl/Cmd+Shift+O |
| Outline mode | Ctrl/Cmd+Y |
| Measure distances | Hold Alt with a selection |
| Select matching layers | Ctrl/Cmd+Alt+A |
| Find and replace text | Ctrl/Cmd+F |
| Arrow | Shift+L |
| Pan | Space+drag, or scroll |
| Zoom | Ctrl/Cmd+scroll, Ctrl/Cmd + / −, Shift+0 (100%) |
| Zoom to fit / to selection | Shift+1 / Shift+2 |
| Rulers / layout grids | Shift+R / Ctrl/Cmd+Shift+4 |
| Undo / Redo | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (Ctrl+Y is outline mode, as in Figma) |
| Duplicate | Ctrl/Cmd+D, or Alt+drag |
| Group / Wrap in frame / Ungroup | Ctrl/Cmd+G / Ctrl/Cmd+Alt+G / Ctrl/Cmd+Shift+G |
| Create component / Combine as variants | Ctrl/Cmd+Alt+K / Ctrl/Cmd+Alt+Shift+K |
| Detach instance | Ctrl/Cmd+Alt+B |
| Use as mask | Ctrl/Cmd+Alt+M |
| Add auto layout | Shift+A |
| Rename selected layers | Ctrl/Cmd+R |
| Place image | Ctrl/Cmd+Shift+K, drop, or paste |
| Crop image | Double-click an image. Enter or Esc finishes |
| Present | Ctrl/Cmd+Alt+Enter. In the presentation: arrow keys, R to restart, Esc to leave |
| Export file | Ctrl/Cmd+Shift+E |
| Bring forward / Send backward | Ctrl/Cmd+] / Ctrl/Cmd+[ (add Shift for front or back) |
| Hide / Lock | Ctrl/Cmd+Shift+H / Ctrl/Cmd+Shift+L |
| Select children / parent | Enter / Shift+Enter |
| Next / previous sibling | Tab / Shift+Tab |
| Nudge | Arrow keys (Shift for 10 px) |
| Edit text | Double-click, or Enter. Esc finishes. Ctrl/Cmd+B, I, U style the selected text |

Shortcuts use physical key positions, so they work with any keyboard layout, including Korean input.

## Security

The editor is built to be reachable only by your own browser:

- **Binding**: the server listens on 127.0.0.1 only.
- **Host and origin checks**: requests with an unknown `Host` header are refused, which blocks DNS rebinding.
  Writes must come from the app's own origin with a JSON body, which blocks cross-site requests.
- **Validation**: every request body is checked against strict schemas. The layer tree is checked on
  every save and import: no cycles, a nesting limit, layers only on existing pages, and no component that
  contains itself. Request bodies are size-limited.
- **Images**: uploads are recognised by their bytes. Only PNG, JPEG, WebP and GIF are accepted, never SVG.
  Images are stored under their SHA-256, and imported images must match their hash. A file holds up to
  1 GB of images.
- **Limits**: layer counts, nesting, component expansion, versions and comments per file are capped, so a
  hostile import or paste can't exhaust memory or disk.
- **Page and file safety**: the built page is served with a strict Content Security Policy. Text and names
  are escaped in SVG export.

## Web version

`npm run build:web` builds the app for static hosting into `dist-web/`. That build stores files in the
browser (IndexedDB) instead of talking to the local server, checks every change with the same schemas
and limits as the server, and carries its own Content Security Policy. A push to `main` deploys it to
GitHub Pages (`.github/workflows/pages.yml`).

## Development

```bash
npm run typecheck
npm test            # unit tests (engine, server)
npm run test:e2e    # browser tests (needs: npx playwright install chromium)
npm run test:e2e:web  # the same browser tests against the web build
```

```
shared/   document schema and tree validation (client and server)
server/   local HTTP server and SQLite storage
src/engine/  canvas engine: scene model, geometry, hit testing, rendering, tools, history, export
src/ui/   React panels: file list, title bar, tools, layers, properties, comments, presentation
tests/    unit and end-to-end tests
```
