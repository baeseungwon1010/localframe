import { useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { Editor } from '../../engine/editor.ts';
import { IconButton } from '../components.tsx';
import { useEditorRev } from '../hooks.ts';
import { t } from '../i18n.ts';
import { type CommentStore, CommentsPanel } from './Comments.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';

type Tab = 'edit' | 'layers';

/**
 * On a phone the side panels don't fit: they open in a sheet from the bottom instead, half the
 * screen tall (or all of it), over the canvas. The comment list takes the first tab while the
 * comment tool is on.
 */
export function PhoneSheet(props: { editor: Editor; fileName: string; comments: CommentStore; onPresent: () => void; onClose: () => void }) {
  const { editor } = props;
  useEditorRev(editor, 'tool');
  const [tab, setTab] = useState<Tab>('edit');
  const [full, setFull] = useState(false);
  const commenting = editor.tool === 'comment';
  return (
    <section className={`phone-sheet ${full ? 'full' : ''}`} aria-label={t('Edit panel')}>
      <div className="sheet-head">
        <div className="sheet-tabs" role="tablist" aria-label={t('Panels')}>
          {(
            [
              ['edit', commenting ? 'Comments' : 'Properties'],
              ['layers', 'Layers'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="sheet-tab" onClick={() => setTab(id)}>
              {t(label)}
            </button>
          ))}
        </div>
        <IconButton label={full ? t('Show less') : t('Show more')} onClick={() => setFull(!full)}>
          {full ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronUp size={16} strokeWidth={1.5} />}
        </IconButton>
        <IconButton label={t('Close panel')} onClick={props.onClose}>
          <X size={16} strokeWidth={1.5} />
        </IconButton>
      </div>
      <div className="sheet-body" role="tabpanel">
        {tab === 'layers' ? (
          <LeftPanel editor={editor} />
        ) : commenting ? (
          <CommentsPanel editor={editor} store={props.comments} />
        ) : (
          <PropertiesPanel editor={editor} fileName={props.fileName} onPresent={props.onPresent} />
        )}
      </div>
    </section>
  );
}
