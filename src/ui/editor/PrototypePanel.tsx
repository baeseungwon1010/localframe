import { Minus, Play, Plus } from 'lucide-react';
import { type Reaction, type SceneNode, ACTIONS, DIRECTIONS, EASINGS, TRANSITIONS, TRIGGERS } from '../../../shared/schema.ts';
import type { Editor } from '../../engine/editor.ts';
import { IconButton } from '../components.tsx';
import { NumberField, Section, SelectField } from './fields.tsx';

const ICON = { size: 14, strokeWidth: 1.5 };

const TRIGGER_LABEL: Record<Reaction['trigger'], string> = { click: 'On click', 'mouse-enter': 'Mouse enter', 'after-delay': 'After delay' };
const ACTION_LABEL: Record<Reaction['action'], string> = {
  navigate: 'Navigate to',
  back: 'Back',
  overlay: 'Open overlay',
  'close-overlay': 'Close overlay',
  'change-to': 'Change to (variant)',
  'set-mode': 'Set variable mode',
};
const TRANSITION_LABEL: Record<Reaction['transition'], string> = {
  instant: 'Instant',
  dissolve: 'Dissolve',
  'smart-animate': 'Smart animate',
  'move-in': 'Move in',
  push: 'Push',
  'slide-in': 'Slide in',
};
const EASING_LABEL: Record<Reaction['easing'], string> = { linear: 'Linear', 'ease-in': 'Ease in', 'ease-out': 'Ease out', 'ease-in-out': 'Ease in and out' };
const DIRECTION_LABEL: Record<NonNullable<Reaction['direction']>, string> = { left: 'From right', right: 'From left', up: 'From bottom', down: 'From top' };

const opts = <T extends string>(values: readonly T[], labels: Record<T, string>) => values.map((v) => ({ value: v, label: labels[v] }));

/** The Prototype tab: the page's starting frame, and the selected layer's interactions. */
export function PrototypePanel({ editor, nodes, onPresent }: { editor: Editor; nodes: SceneNode[]; onPresent: () => void }) {
  const frames = editor.topFrames();
  const page = editor.currentPage;
  const single = nodes.length === 1 ? nodes[0] : null;

  if (!single) {
    return (
      <>
        <div className="panel-title">
          Prototype<span className="panel-subtitle">{page.name}</span>
        </div>
        <Section title="Starting frame">
          {frames.length === 0 ? (
            <p className="field-caption">Draw a frame to start a prototype. Each top-level frame is a screen.</p>
          ) : (
            <SelectField
              label="Starting frame"
              value={page.prototypeStart && frames.some((f) => f.id === page.prototypeStart) ? page.prototypeStart : ''}
              options={[{ value: '', label: 'First frame' }, ...frames.map((f) => ({ value: f.id, label: f.name }))]}
              onChange={(v) => editor.setPrototypeStart(v || null)}
            />
          )}
          <SelectField
            label="Device"
            value={page.device ?? 'none'}
            options={[
              { value: 'none', label: 'No device frame' },
              { value: 'phone', label: 'Phone' },
              { value: 'tablet', label: 'Tablet' },
              { value: 'desktop', label: 'Desktop' },
            ]}
            onChange={(v) => editor.setPrototypeDevice(v === 'none' ? null : v)}
          />
          <button type="button" className="btn secondary full" disabled={frames.length === 0} onClick={onPresent}>
            <Play {...ICON} /> Present
          </button>
          <p className="field-caption">Select a layer to make it open another frame when clicked.</p>
        </Section>
      </>
    );
  }

  const reactions = single.reactions ?? [];
  const own = topOf(editor, single);
  const destinations = frames.filter((f) => f.id !== own);
  // variants this layer's component can change to: the other components of its set
  const comp = componentOf(editor, single);
  const variantSet = comp?.parentId ? editor.doc.get(comp.parentId) : undefined;
  const variants =
    variantSet?.type === 'COMPONENT_SET'
      ? editor.doc
          .children(variantSet.id)
          .map((id) => editor.doc.get(id)!)
          .filter((v) => v.type === 'COMPONENT' && v.id !== comp!.id)
      : [];
  const collections = editor.variables.collections;
  const isScreenFrame = single.type === 'FRAME' && frames.some((f) => f.id === single.id);
  const inScrolling = !isScreenFrame && !!editor.doc.get(own)?.overflow;
  const set = (next: Reaction[]) => editor.updateNodes([single.id], (n) => ({ ...n, reactions: next.length ? next : undefined }));
  const change = (i: number, patch: Partial<Reaction>) => set(reactions.map((r, j) => (j === i ? clean({ ...r, ...patch }) : r)));
  const add = () =>
    set([
      ...reactions,
      clean({
        trigger: 'click',
        action: 'navigate',
        destinationId: destinations[0]?.id,
        transition: 'instant',
        duration: 300,
        easing: 'ease-out',
      }),
    ]);

  return (
    <>
      <div className="panel-title">
        Prototype<span className="panel-subtitle">{single.name}</span>
      </div>
      <Section
        title="Interactions"
        action={
          <IconButton label="Add interaction" onClick={add} disabled={reactions.length >= 20}>
            <Plus {...ICON} />
          </IconButton>
        }
      >
        {reactions.length === 0 && <p className="field-caption">Nothing happens when this layer is clicked. Add an interaction to link it to another frame.</p>}
        {reactions.map((r, i) => {
          const needsDest = r.action === 'navigate' || r.action === 'overlay';
          const moves = r.transition === 'move-in' || r.transition === 'push' || r.transition === 'slide-in';
          return (
            <div className="reaction" key={i} role="group" aria-label={`Interaction ${i + 1}`}>
              <div className="reaction-row">
                <SelectField label="Trigger" value={r.trigger} options={opts(TRIGGERS, TRIGGER_LABEL)} onChange={(v) => change(i, { trigger: v })} />
                {r.trigger === 'after-delay' && (
                  <NumberField label="" ariaLabel="Delay" value={r.delay ?? 800} min={0} max={60_000} precision={0} suffix="ms" onCommit={(v) => change(i, { delay: Math.round(v) })} />
                )}
                <IconButton label={`Remove interaction ${i + 1}`} onClick={() => set(reactions.filter((_, j) => j !== i))}>
                  <Minus {...ICON} />
                </IconButton>
              </div>
              <div className="grid2">
                <SelectField label="Action" value={r.action} options={opts(ACTIONS, ACTION_LABEL)} onChange={(v) => change(i, { action: v })} />
                {needsDest && (
                  <SelectField
                    label="Destination"
                    value={r.destinationId && destinations.some((f) => f.id === r.destinationId) ? r.destinationId : ''}
                    options={[{ value: '', label: 'Pick a frame' }, ...destinations.map((f) => ({ value: f.id, label: f.name }))]}
                    onChange={(v) => change(i, { destinationId: v || undefined })}
                  />
                )}
                {r.action === 'change-to' && (
                  <SelectField
                    label="Variant"
                    value={r.destinationId && variants.some((v) => v.id === r.destinationId) ? r.destinationId : ''}
                    options={[{ value: '', label: variants.length ? 'Pick a variant' : 'Not in a variant set' }, ...variants.map((v) => ({ value: v.id, label: v.name }))]}
                    onChange={(v) => change(i, { destinationId: v || undefined })}
                  />
                )}
              </div>
              {r.action === 'set-mode' && (
                <div className="grid2">
                  <SelectField
                    label="Collection"
                    value={r.collectionId ?? ''}
                    options={[{ value: '', label: collections.length ? 'Collection' : 'No variables yet' }, ...collections.map((c) => ({ value: c.id, label: c.name }))]}
                    onChange={(v) => change(i, { collectionId: v || undefined, modeId: collections.find((c) => c.id === v)?.modes[0]?.id })}
                  />
                  <SelectField
                    label="Mode"
                    value={r.modeId ?? ''}
                    options={[{ value: '', label: 'Mode' }, ...(collections.find((c) => c.id === r.collectionId)?.modes ?? []).map((m) => ({ value: m.id, label: m.name }))]}
                    onChange={(v) => change(i, { modeId: v || undefined })}
                  />
                </div>
              )}
              {r.action !== 'back' && r.action !== 'close-overlay' && r.action !== 'change-to' && r.action !== 'set-mode' && (
                <>
                  <div className="grid2">
                    <SelectField label="Animation" value={r.transition} options={opts(TRANSITIONS, TRANSITION_LABEL)} onChange={(v) => change(i, { transition: v })} />
                    {moves && <SelectField label="Direction" value={r.direction ?? 'left'} options={opts(DIRECTIONS, DIRECTION_LABEL)} onChange={(v) => change(i, { direction: v })} />}
                  </div>
                  {r.transition !== 'instant' && (
                    <div className="grid2">
                      <SelectField label="Easing" value={r.easing} options={opts(EASINGS, EASING_LABEL)} onChange={(v) => change(i, { easing: v })} />
                      <NumberField label="" ariaLabel="Duration" value={r.duration} min={0} max={10_000} precision={0} suffix="ms" onCommit={(v) => change(i, { duration: Math.round(v) })} />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </Section>
      {isScreenFrame && (
        <Section title="Scrolling">
          <SelectField
            label="Scroll direction"
            value={single.overflow ?? 'none'}
            options={[
              { value: 'none', label: 'No scrolling' },
              { value: 'vertical', label: 'Vertical' },
              { value: 'horizontal', label: 'Horizontal' },
              { value: 'both', label: 'Both directions' },
            ]}
            onChange={(v) => editor.updateNodes([single.id], (n) => ({ ...n, overflow: v === 'none' ? undefined : v }))}
          />
          <p className="field-caption">When presenting, content outside the frame scrolls into view.</p>
        </Section>
      )}
      {inScrolling && (
        <Section title="Scrolling">
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!single.fixedOnScroll}
              onChange={(e) => editor.updateNodes([single.id], (n) => ({ ...n, fixedOnScroll: e.target.checked || undefined }))}
            />
            Fixed when scrolling
          </label>
        </Section>
      )}
    </>
  );
}

/** Drops fields that don't apply to a reaction's trigger, action or animation. */
function clean(r: Reaction): Reaction {
  const out: Reaction = { ...r };
  if (out.trigger !== 'after-delay') delete out.delay;
  else out.delay ??= 800;
  if (out.action !== 'navigate' && out.action !== 'overlay' && out.action !== 'change-to') delete out.destinationId;
  if (out.action !== 'set-mode') {
    delete out.collectionId;
    delete out.modeId;
  }
  if (out.transition === 'move-in' || out.transition === 'push' || out.transition === 'slide-in') out.direction ??= 'left';
  else delete out.direction;
  return out;
}

/** The component a layer belongs to (itself, or the nearest one above it). */
function componentOf(editor: Editor, n: SceneNode): SceneNode | undefined {
  for (let cur: SceneNode | undefined = n; cur; cur = cur.parentId ? editor.doc.get(cur.parentId) : undefined) if (cur.type === 'COMPONENT') return cur;
  return undefined;
}

/** The screen a layer is on: its top-level frame, or the frame inside a section. */
function topOf(editor: Editor, n: SceneNode): string {
  let cur = n;
  for (let guard = 0; cur.parentId && !editor.doc.get(cur.parentId)?.section && guard < 200; guard++) cur = editor.doc.get(cur.parentId)!;
  return cur.id;
}
