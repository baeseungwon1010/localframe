# localframe

A local-first canvas design editor. Draw frames, shapes, connectors and text on an infinite canvas, place
images, build components and auto layout, organise everything in pages and layers, and export PNG, JPG,
WebP, SVG, PDF or a portable file. Everything runs on your machine: no account, no cloud, no third-party
requests.

## Features

- **Files**: create, rename, delete, import and export. Every change autosaves to a local SQLite file, and
  each file shows a thumbnail in the file list.
- **Pages**: add, rename, duplicate, reorder and delete pages. Each page has its own background, and layers
  can be moved to another page.
- **Canvas**: infinite canvas with pan and zoom (Space-drag, scroll, Ctrl/Cmd+scroll or pinch), zoom to fit or
  to the selection, and light and dark themes.
- **Draw**:
  - frames, including nested frames with clip content
  - rectangles with per-corner radius
  - ellipses
  - lines and arrows
  - text with auto width, auto height or a fixed size
  Shift keeps proportions or 45° angles, and Alt draws from the centre. Shapes drawn inside a frame
  become its children.
- **Edit**:
  - Select, Shift-select and marquee. Double-click goes deeper into frames, and Ctrl/Cmd-click selects
    the deepest layer.
  - Move with smart guides and snapping, nudge with the arrow keys, and Alt-drag to duplicate.
  - Resize with 8 handles. Rotate from just outside a corner. Frame children follow their constraints.
  - Drag layers into or out of frames.
  - Undo and redo, copy, cut, paste (also between tabs), duplicate, delete and z-order.
  - Ctrl/Cmd+G wraps the selection in a frame, and Ctrl/Cmd+Shift+G removes the frame.
  - Align and distribute.
- **Images**: place PNG, JPEG, WebP or GIF images with the picker (Ctrl/Cmd+Shift+K), by dropping files on
  the canvas, or by pasting. An image is an image fill on a rectangle, set to fill, fit or stretch.
- **Components**: turn a frame into a component (Ctrl/Cmd+Alt+K) and place instances from the Assets tab.
  Instances follow the main component. Their text can be changed per instance, and they can be
  detached (Ctrl/Cmd+Alt+B).
- **Auto layout**: Shift+A stacks a frame's content vertically or horizontally, with gap, padding,
  alignment, and hug or fixed size. Children can fill the container or ignore the layout. Dragging a
  child reorders it.
- **Connectors**: a line or arrow drawn from one shape to another attaches to both and follows them when
  they move. Dropping an end on a side's midpoint pins it to that side; Ctrl/Cmd while drawing leaves the
  ends loose.
- **Properties**: position, rotation, size with aspect lock, and corner radius. Also constraints, opacity,
  fills and strokes (colour, opacity, weight, inside/center/outside, dashed), arrow heads, and text
  (font, weight, size, line height, letter spacing, alignment, resizing). Fields accept maths, like `120/2`.
- **Layers panel**: tree view with rename, hide, lock, drag to reorder or reparent, and keyboard navigation.
- **Export a selection or page**: PNG, JPG, WebP (1x to 4x), SVG or PDF.
- **Export a whole file** (Ctrl/Cmd+Shift+E, or the file list menu):
  - as a `.localframe.json` that keeps everything editable, images included;
  - as a PDF with one page per frame;
  - as PNG, JPG, WebP or SVG files, one per frame. Several files come in a ZIP, with a folder per page.
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
| Move, Frame, Rectangle, Ellipse, Line, Text, Hand | V, F, R, O, L, T, H |
| Arrow | Shift+L |
| Pan | Space+drag, or scroll |
| Zoom | Ctrl/Cmd+scroll, Ctrl/Cmd + / −, Shift+0 (100%) |
| Zoom to fit / to selection | Shift+1 / Shift+2 |
| Undo / Redo | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z |
| Duplicate | Ctrl/Cmd+D, or Alt+drag |
| Wrap in frame / Remove frame | Ctrl/Cmd+G / Ctrl/Cmd+Shift+G |
| Create component / Detach instance | Ctrl/Cmd+Alt+K / Ctrl/Cmd+Alt+B |
| Add auto layout | Shift+A |
| Place image | Ctrl/Cmd+Shift+K, drop, or paste |
| Export file | Ctrl/Cmd+Shift+E |
| Bring forward / Send backward | Ctrl/Cmd+] / Ctrl/Cmd+[ (add Shift for front or back) |
| Hide / Lock | Ctrl/Cmd+Shift+H / Ctrl/Cmd+Shift+L |
| Select children / parent | Enter / Shift+Enter |
| Next / previous sibling | Tab / Shift+Tab |
| Nudge | Arrow keys (Shift for 10 px) |
| Edit text | Double-click, or Enter. Esc finishes |

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
  Images are stored under their SHA-256, and imported images must match their hash.
- **Page and file safety**: the built page is served with a strict Content Security Policy. Text and names
  are escaped in SVG export.

## Development

```bash
npm run typecheck
npm test            # unit tests (engine, server)
npm run test:e2e    # browser tests (needs: npx playwright install chromium)
```

```
shared/   document schema and tree validation (client and server)
server/   local HTTP server and SQLite storage
src/engine/  canvas engine: scene model, geometry, hit testing, rendering, tools, history, export
src/ui/   React panels: file list, title bar, tools, layers, properties
tests/    unit and end-to-end tests
```
