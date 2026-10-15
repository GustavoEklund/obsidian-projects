// Shared by the generators that record what a function did: its value, or the message it threw. (Not a generator itself:
// only `*.fixture.ts` files are loaded as generators.)
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

export function attempt<T>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
