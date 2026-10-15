import { useEffect, useRef, useState } from 'react';
import { downloadBlob } from './download.ts';
import { t } from './i18n.ts';
import { FILE_EXPORT_FORMATS, type FileExportFormat, exportWholeFile, printWholeFile } from './fileExport.ts';

/** Picks a format and exports the whole file. */
export function ExportFileDialog(props: { fileId: string; fileName: string; onClose: () => void; beforeExport?: () => Promise<void> }) {
  const [format, setFormat] = useState<FileExportFormat>('pdf');
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, props]);

  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await props.beforeExport?.();
      if (format === 'print') {
        await printWholeFile(props.fileId);
        setMessage({ text: t('Sent to the print dialog'), error: false });
        return;
      }
      const { blob, filename } = await exportWholeFile(props.fileId, format, scale);
      downloadBlob(blob, filename);
      setMessage({ text: t('Exported {filename}', { filename }), error: false });
    } catch (e) {
      setMessage({ text: t("Couldn't export: {reason}", { reason: e instanceof Error ? t(e.message) : t('unknown error') }), error: true });
    } finally {
      setBusy(false);
    }
  };

  const raster = format === 'png' || format === 'jpg' || format === 'webp' || format === 'pdf';

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !busy && props.onClose()}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <h2 id="export-title">{t('Export “{name}”', { name: props.fileName })}</h2>
        <fieldset className="format-list">
          <legend>{t('Format')}</legend>
          {FILE_EXPORT_FORMATS.map((f) => (
            <label key={f.value} className={`format-option ${format === f.value ? 'on' : ''}`}>
              <input type="radio" name="format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} />
              <span>
                <span className="format-label">{t(f.label)}</span>
                <span className="format-detail">{t(f.detail)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {raster && (
          <label className="dialog-row">
            {t('Resolution')}
            <select className="select-field" value={scale} onChange={(e) => setScale(Number(e.target.value))} aria-label={t('Resolution')}>
              {[1, 2, 3, 4].map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
        )}
        {message && (
          <p className={`field-caption ${message.error ? 'error-text' : ''}`} role="status">
            {message.text}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={props.onClose} disabled={busy}>
            {t('Close')}
          </button>
          <button type="button" className="btn primary" onClick={run} disabled={busy}>
            {busy ? t('Exporting…') : t('Export')}
          </button>
        </div>
      </div>
    </div>
  );
}
