import { useState } from 'react';
import { Copy } from 'lucide-react';
import type { SceneNode } from '../../../shared/schema.ts';
import { cssFor } from '../../engine/css.ts';
import type { Editor } from '../../engine/editor.ts';
import { IconButton } from '../components.tsx';
import { Section } from './fields.tsx';
import { t } from '../i18n.ts';

/** The Code tab: CSS for the selected layer, ready to copy. */
export function CodePanel({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const [copied, setCopied] = useState(false);
  if (nodes.length !== 1) {
    return (
      <>
        <div className="panel-title">{t('Code')}</div>
        <p className="panel-empty">{t('Select one layer to see its CSS.')}</p>
      </>
    );
  }
  const node = nodes[0];
  const lines = cssFor(editor.doc, node);
  const text = `/* ${node.name.replace(/\*\//g, '* /')} */\n${lines.join('\n')}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text can still be selected */
    }
  };
  return (
    <>
      <div className="panel-title">
        {t('Code')}<span className="panel-subtitle">{node.name}</span>
      </div>
      <Section
        title="CSS"
        action={
          <IconButton label={copied ? t('Copied') : t('Copy CSS')} onClick={copy}>
            <Copy size={14} strokeWidth={1.5} />
          </IconButton>
        }
      >
        <pre className="code-block" aria-label={t('CSS for the selected layer')} tabIndex={0}>
          {text}
        </pre>
        <p className="field-caption" role="status">
          {copied ? t('Copied to the clipboard') : t('Positions are relative to the parent frame. Auto layout becomes flexbox.')}
        </p>
      </Section>
    </>
  );
}
