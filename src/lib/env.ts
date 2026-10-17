/**
 * Environment access that works both under Astro/Vite (`import.meta.env`)
 * and in plain Node (tests, `node --test`). Reads are unprefixed so the same
 * variable works locally (`.env`) and on Vercel (Project Settings).
 */

type Env = Record<string, string | undefined>;

function fromProcess(): Env {
  return typeof process !== 'undefined' ? ((process.env ?? {}) as Env) : {};
}

function fromImportMeta(): Env {
  try {
    const meta = (import.meta as unknown as { env?: Env }).env;
    return meta ?? {};
  } catch {
    return {};
  }
}

export function env(name: string): string | undefined {
  const value = fromProcess()[name] ?? fromImportMeta()[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
