import './zodSetup.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// the interface font; the fonts layers use load with the editor (ui/canvasFonts.ts)
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';

import './ui/styles/tokens.css';
import './ui/styles/app.css';
import { App } from './ui/App.tsx';
import { startApp } from './ui/pwa.ts';

startApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
