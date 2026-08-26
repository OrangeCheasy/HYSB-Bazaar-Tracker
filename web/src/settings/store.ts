import { useSyncExternalStore } from "react";
import { defaultSettings, migrate, type Settings } from "./schema.js";

/**
 * Settings persistence.
 *
 * `localStorage` and nothing else — there are no user accounts in v1 (CLAUDE.md §7.5),
 * and adding auth to remember a tax rate means handling PII, which is a different project
 * with different obligations.
 *
 * A module-level store rather than React context: settings are read by the API client and
 * by `toQuery`, neither of which is a component, and `useSyncExternalStore` gives every
 * subscriber a tearing-free read of the same snapshot.
 */

/** Versioned so a future incompatible shape can be introduced without reading the old
 *  one — `migrate` handles everything short of that. */
export const STORAGE_KEY = "hysb:settings:v1";

let snapshot: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  // Every access is guarded: Safari private mode throws on `localStorage` rather than
  // returning null, and a thrown getter must not take the whole app down over a tax rate.
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return defaultSettings();
    return migrate(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

function persist(next: Settings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked. The in-memory snapshot is still correct for this session,
    // so the settings work and simply do not survive a reload — strictly better than
    // refusing the change.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSettings(): Settings {
  return snapshot;
}

export function setSettings(next: Settings): void {
  snapshot = next;
  persist(next);
  emit();
}

export function updateSettings(patch: Partial<Settings>): void {
  setSettings({ ...snapshot, ...patch });
}

export function resetSettings(): void {
  setSettings(defaultSettings());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // A second tab writing the same key fires `storage` here but not in the tab that wrote
  // it. Without this, two open tabs drift apart and the stale one keeps scanning with a
  // tax rate the user thinks they changed.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    snapshot = load();
    emit();
  };
  globalThis.addEventListener?.("storage", onStorage);

  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** The whole settings object. Components re-render when any field changes — the drawer is
 *  small and the views read several fields each, so per-field selectors would be
 *  ceremony without a measurable win. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
