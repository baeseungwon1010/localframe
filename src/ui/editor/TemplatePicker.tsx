import { CalendarDays, ChartGantt, Lightbulb, ListChecks, Network, Route, SquareKanban, Users, Workflow } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import { TEMPLATES, type TemplateKind } from '../../engine/templates.ts';
import { t } from '../i18n.ts';

const ICONS: Record<TemplateKind, typeof Workflow> = {
  flowchart: Workflow,
  brainstorm: Lightbulb,
  retro: ListChecks,
  mindmap: Network,
  kanban: SquareKanban,
  timeline: ChartGantt,
  orgchart: Users,
  userflow: Route,
  weekly: CalendarDays,
};

/** On an empty board in diagram mode: start from a template, or from nothing. */
export function TemplatePicker({ editor }: { editor: Editor }) {
  return (
    <section className="template-picker" aria-label={t('Start with a template')}>
      <h2>{t('Start with a template')}</h2>
      <div className="template-list">
        {TEMPLATES.map((tpl) => {
          const Icon = ICONS[tpl.kind];
          return (
            <button key={tpl.kind} type="button" className={`template-card ${tpl.kind}`} onClick={() => editor.insertTemplate(tpl.kind)}>
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
              <span className="template-name">{t(tpl.name)}</span>
              <span className="template-desc">{t(tpl.description)}</span>
            </button>
          );
        })}
      </div>
      <p>{t('Or start from nothing: pick a tool below (N adds a sticky note).')}</p>
    </section>
  );
}
