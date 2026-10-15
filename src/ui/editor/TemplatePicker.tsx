import { Lightbulb, ListChecks, Workflow } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import { TEMPLATES, type TemplateKind } from '../../engine/templates.ts';

const ICONS: Record<TemplateKind, typeof Workflow> = { flowchart: Workflow, brainstorm: Lightbulb, retro: ListChecks };

/** On an empty board in diagram mode: start from a template, or from nothing. */
export function TemplatePicker({ editor }: { editor: Editor }) {
  return (
    <section className="template-picker" aria-label="Start with a template">
      <h2>Start with a template</h2>
      <div className="template-list">
        {TEMPLATES.map((t) => {
          const Icon = ICONS[t.kind];
          return (
            <button key={t.kind} type="button" className={`template-card ${t.kind}`} onClick={() => editor.insertTemplate(t.kind)}>
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
              <span className="template-name">{t.name}</span>
              <span className="template-desc">{t.description}</span>
            </button>
          );
        })}
      </div>
      <p>Or start from nothing: press N for a sticky note, or pick a tool below.</p>
    </section>
  );
}
