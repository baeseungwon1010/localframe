/**
 * Text the engine writes into a file for the person (a template's notes and section names). The
 * interface sets the translator for its language; the engine itself knows no languages.
 */
let translator: (en: string) => string = (en) => en;

export function setTranslator(fn: (en: string) => string) {
  translator = fn;
}

/** The text in the interface's language (a trailing line break is kept as it is). */
export function tr(en: string): string {
  return en.endsWith('\n') ? `${translator(en.slice(0, -1))}\n` : translator(en);
}
