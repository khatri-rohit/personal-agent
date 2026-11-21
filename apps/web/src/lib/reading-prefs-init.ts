/**
 * Server-safe half of reading-prefs: storage keys and the pre-paint init
 * script that layout.tsx (a server component) inlines. Kept apart from the
 * hooks, which Next.js only allows in client modules.
 */
export const TEXT_SIZE_KEY = 'desk-ui-text-size';
export const DIAGNOSTICS_KEY = 'desk-ui-run-diagnostics';

/** Runs before paint so the first frame has the reader's text size. */
export const READING_PREFS_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(TEXT_SIZE_KEY)});if(s==='sm'||s==='lg')document.documentElement.dataset.textSize=s;}catch(e){}})();`;
