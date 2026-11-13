# Diagram specs

A diagram spec describes a diagram by what it says: the boxes, what leads to what, which boxes
belong together and what each one is for. `npm run diagram` turns it into a localframe file, laid
out and styled, plus a picture and a list of problems. Nobody writing a spec (a person or an AI)
places, sizes or colours anything by hand.

This page is written to be handed to an AI agent as its instructions.

## The loop

```bash
npm run diagram -- my-diagram.json
```

For `my-diagram.json` this writes, next to it (or in `--out <dir>`):

| file | what it is |
| --- | --- |
| `my-diagram.localframe.json` | the diagram: Import file in localframe opens it, fully editable |
| `my-diagram.png`, `.svg` | a picture of it (PNG needs Playwright's Chromium; `--no-png` skips it) |
| `my-diagram.lint.json` | the problems found, each with what to change in the spec |

It prints the problems too, and exits 1 on a spec it can't read or a diagram with errors.

**Work like this**: write the spec, run it, look at the PNG, read the lint, change the spec, run it
again. Stop when there are no warnings left that you can fix and the picture says what it should.
Never edit the `.localframe.json` to fix layout: change the spec.

## Without a terminal: a link, or a paste

An AI in a chat (with no tools to run) can still hand over a finished diagram:

- **A link.** `https://baeseungwon1010.github.io/localframe/#/diagram/` followed by the spec as
  JSON, percent-encoded (what `encodeURIComponent` does). Opening it draws the diagram, shows it
  and offers to save it. The spec stays in the link: the part after `#` never reaches a server.
  Chat apps may cut links over about 8000 characters, so keep the spec short.
- **A paste.** Copy the spec's JSON, open localframe and press Ctrl+V (⌘V) on the file list, or
  use Import file on a `.json` file holding it. It opens as a board.

Without the picture and the lint, check the spec against the rules below before handing it over.

## The spec

```json
{
  "title": "Checkout",
  "subtitle": "What happens after Pay is pressed",
  "direction": "right",
  "groups": [{ "id": "pay", "title": "Payment provider", "nodes": ["card", "charge"] }],
  "nodes": [
    "cart: Cart",
    { "id": "card", "text": "Card details", "note": "Number, expiry, CVC" },
    "charge: Charge the card",
    { "id": "ok", "text": "Paid", "role": "ok" },
    { "id": "fail", "text": "Declined", "role": "danger" }
  ],
  "edges": [
    "cart -> card: Pay",
    "card -> charge",
    "charge -> ok: approved",
    "charge -> fail: declined",
    "fail --> card: try again"
  ]
}
```

### Top level

| key | | |
| --- | --- | --- |
| `title` | optional | shown large, top left |
| `subtitle` | optional | one line under the title: what the diagram is about |
| `direction` | `right` (default) or `down` | which way the flow runs |
| `nodes` | required, 1 to 200 | the boxes |
| `edges` | optional | what leads to what |
| `groups` | optional | boxes that belong together, drawn in a frame with a title |

### Nodes

A node is a string or an object.

- `"id"`: a box whose text is its id.
- `"id: Text"`: a box with an id and its own text.
- `{ "id", "text", "note", "shape", "role", "group" }`, all but `id` optional:
  - `text`: the words in the box (short: a name or a step).
  - `note`: one or two smaller lines under the text, for detail.
  - `shape`: `box` (default), `pill`, `ellipse`, `diamond` (a decision), `cylinder` (a store or
    database), `document`, `chevron` (a step in a sequence), `parallelogram` (input or output),
    `bubble` (something said), `note` (a sticky note).
  - `role`: what the box is, which picks its colour:

    | role | use it for | colour |
    | --- | --- | --- |
    | `default` | most boxes | white |
    | `primary` | the one box the diagram is about | blue |
    | `ok` | a good outcome | green |
    | `warning` | a doubtful outcome, a check | yellow |
    | `danger` | a bad outcome, a block | red |
    | `external` | something outside the system (a service, a third party) | violet |
    | `muted` | optional or minor | grey, dashed |
  - `group`: the id of the group it belongs to (or list it in the group's `nodes`).

### Edges

A string or an object.

- `"a -> b"`: an arrow from a to b. `"a -> b: label"` puts words on it.
- `"a --> b"`: dashed (a return, a retry, something optional).
- `"a <-> b"`: both ways, for a request and its answer. Label it `"request / answer"`; this is
  clearer than two arrows.
- `"a -- b"`: a plain line.
- `{ "from", "to", "label", "style": "solid" | "dashed", "arrow": "end" | "both" | "none" }`.

### Groups

`{ "id", "title", "nodes": [...], "role" }`. A frame around the boxes, with its title inside the
top. The role tints the frame (`muted`, grey, if left out).

## What makes a good diagram

The builder takes care of layout and looks. What it can't fix is what the spec says:

- **One idea per diagram.** If it needs more than about 15 boxes, or the lint says the text gets
  tiny, make two diagrams (an overview and a detail) instead of one crowded one.
- **Short box text, details in the note.** A box's text names the thing in a few words
  (under 40 characters); the note says the rest (under 90).
- **List nodes in the order the flow visits them.** The layout follows edges, but ties go by the
  order given; this keeps edges from crossing.
- **Colour for meaning only.** Most boxes stay `default`. Give a role to the few boxes it singles
  out: outcomes, warnings, the main subject. If everything is coloured, nothing stands out.
- **Label edges when the arrow alone is ambiguous** (what is passed, which answer), not every one.
- **One edge for a request and its reply** (`<->` with `"ask / answer"`), and dashed edges for the
  way back.
- **Groups for real boundaries**: stages of a pipeline, inside versus outside a system, teams.
  A group's boxes should be next to each other in the flow, or their frames overlap.
- **A long chain reads better going down** (`"direction": "down"`) than as one very wide row.

## Lint codes

| code | level | means | do |
| --- | --- | --- | --- |
| `overlap` | error | two boxes overlap | report it: it's a builder bug |
| `overflow` | error | a box's words don't fit | shorten the text |
| `tiny-text` | warn | fitted to 1600px wide, the smallest text drops under 12px | split the diagram, shorten labels, or go `down` |
| `long-text` | warn | box text over 40 characters | move detail to the note |
| `long-note` | warn | note over 90 characters | shorten, or make it its own box |
| `edge-through-box` | warn | an edge runs through another box | reorder nodes, or add a step |
| `crossings` | info/warn | edges cross | list nodes in flow order, group related ones |
| `group-overlap` | warn | two group frames overlap | keep each group's boxes in their own run of steps |
| `crowded-layer` | warn | more than 7 boxes side by side | group them, or split |
| `too-much-colour` | info | most boxes have a role colour | keep roles for the few that matter |
| `too-big` | warn | over 40 boxes | split it |
