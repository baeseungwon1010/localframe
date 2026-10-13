# localframe

A local-first canvas design editor. Draw frames, shapes, lines, arrows and text on an infinite canvas,
organise them in a layers panel, and export PNG, SVG or a portable file. Everything runs on your machine:
no account, no cloud, no third-party requests.

## Features

- **Files**: create, rename, delete, import and export (`.localframe.json`). Every change autosaves to a
  local SQLite file. Each file shows a thumbnail in the file list.
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
- **Properties**: position, rotation, size with aspect lock, and corner radius. Also constraints, opacity,
  fills and strokes (colour, opacity, weight, inside/center/outside, dashed), arrow heads, and text
  (font, weight, size, line height, letter spacing, alignment, resizing). Fields accept maths, like `120/2`.
- **Layers panel**: tree view with rename, hide, lock, drag to reorder or reparent, and keyboard navigation.
- **Export**: PNG at 1x to 4x, SVG for a selection, a frame or the whole page, and JSON for the whole file.
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
- **Validation**: every request body is checked against strict schemas, and the layer tree is checked on
  every save and import. Request bodies are size-limited.
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
