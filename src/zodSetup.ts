import { z } from 'zod';

// No compiled validators: the page's CSP forbids eval, and Firefox reports even zod's probe for
// it. Imported first in main.tsx, since modules may validate while they load.
z.config({ jitless: true });
