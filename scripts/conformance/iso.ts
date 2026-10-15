// What the Rust crate understands as a timestamp (src/jscompat.rs): strict ISO-8601, no surrounding whitespace.
// V8's Date.parse also reads legacy formats the crate deliberately does not ("12" is 2001-12-01), so generators that
// feed timestamps to the TypeScript core must not use a string V8 reads through its legacy parser.

/** The ISO-8601 forms Rust reads, with V8's leniencies (space for T, a day up to 31, fractions of any length). */
export const STRICT_ISO =
  /^((?!-000000)[+-]\d{6}|\d{4})(-\d{2}(-\d{2})?)?([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

/** True when `Date.parse` of `s` is `NaN` or goes through the strict ISO grammar, i.e. Rust and V8 agree on it. */
export function agreesWithRust(s: string): boolean {
  return STRICT_ISO.test(s) || Number.isNaN(Date.parse(s));
}
