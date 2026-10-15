import { editorAssets } from './editorAssets.ts';
import { editorChrome } from './editorChrome.ts';
import { editorPanels } from './editorPanels.ts';
import { engine } from './engine.ts';
import { files } from './files.ts';

/** Every Korean translation, by its English text. */
export const ko: Record<string, string> = { ...files, ...editorPanels, ...editorAssets, ...editorChrome, ...engine };
