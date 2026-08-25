/**
 * Typed results. Core returns these; only boundaries throw. See CLAUDE.md section 5.
 *
 * This is deliberately the only shared utility module in packages/core. Everything else
 * is domain logic.
 */

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
