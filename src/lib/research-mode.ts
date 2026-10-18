export type ResearchModePreference = 'automatic' | 'standard' | 'deep';
export type EffectiveResearchMode = Exclude<ResearchModePreference, 'automatic'>;

/**
 * Automatic keeps routine lookups lightweight and escalates research-heavy
 * questions to Deep Research without requiring an agent to pass a mode flag.
 */
export function resolveResearchMode(query: string, preference: ResearchModePreference): EffectiveResearchMode {
  if (preference !== 'automatic') return preference;
  const normalized = query.toLowerCase();
  const deepSignals = [
    /\b(compare|comparison|versus|\bvs\.?\b|pros and cons|trade-?offs?)\b/,
    /\b(comprehensive|in[- ]depth|deep dive|thorough|investigate|research|analysis|analyze|analyse)\b/,
    /\b(latest|recent|current state|over time|history|trend|impact|outlook|forecast)\b/,
    /\b(best|top|leading|recommended)\b.{0,60}\b(apps?|tools?|software|platforms?|services?)\b/,
    /\b(current|latest)\s+(best|top|leading)\b/,
    /\b(mejores?|recomendad[oa]s?)\b.{0,60}\b(apps?|aplicaciones|herramientas|software|plataformas?)\b/,
    /\b(compara|comparación|versus|ventajas y desventajas|a fondo|en profundidad|investiga|análisis|analiza|tendencias|impacto|historia|actualizado|reciente)\b/,
  ];
  const hasMultipleQuestions = (query.match(/[?？]/g)?.length ?? 0) > 1;
  const isLongResearchPrompt = query.trim().length >= 240;
  return deepSignals.some((signal) => signal.test(normalized)) || hasMultipleQuestions || isLongResearchPrompt
    ? 'deep'
    : 'standard';
}
