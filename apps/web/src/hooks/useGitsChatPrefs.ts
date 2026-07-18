import { useCallback, useSyncExternalStore } from "react";

// GITS Chat appearance prefs. Kept in localStorage (mirroring useTheme) rather than
// the server settings contract, so the reskin ships without a server migration.
// Default look: OLED theme + cyan accent, glow on, typing sounds on.

export type GitsChatTheme = "oled" | "navy" | "graphite";
export type GitsChatAccent = "cyan" | "magenta" | "emerald" | "amber";

export type GitsChatPrefs = {
  theme: GitsChatTheme;
  accent: GitsChatAccent;
  reduceGlow: boolean;
  typeSound: boolean;
};

export const DEFAULT_GITS_CHAT_PREFS: GitsChatPrefs = {
  theme: "oled",
  accent: "cyan",
  reduceGlow: false,
  typeSound: true,
};

const STORAGE_KEY = "gits:chat-prefs";
const THEMES: readonly GitsChatTheme[] = ["oled", "navy", "graphite"];
const ACCENTS: readonly GitsChatAccent[] = ["cyan", "magenta", "emerald", "amber"];

let listeners: Array<() => void> = [];
let lastSnapshot: GitsChatPrefs = DEFAULT_GITS_CHAT_PREFS;

function hasStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function parse(raw: string | null): GitsChatPrefs {
  if (!raw) return DEFAULT_GITS_CHAT_PREFS;
  try {
    const value = JSON.parse(raw) as Partial<GitsChatPrefs>;
    return {
      theme: THEMES.includes(value.theme as GitsChatTheme)
        ? (value.theme as GitsChatTheme)
        : DEFAULT_GITS_CHAT_PREFS.theme,
      accent: ACCENTS.includes(value.accent as GitsChatAccent)
        ? (value.accent as GitsChatAccent)
        : DEFAULT_GITS_CHAT_PREFS.accent,
      reduceGlow:
        typeof value.reduceGlow === "boolean"
          ? value.reduceGlow
          : DEFAULT_GITS_CHAT_PREFS.reduceGlow,
      typeSound:
        typeof value.typeSound === "boolean" ? value.typeSound : DEFAULT_GITS_CHAT_PREFS.typeSound,
    };
  } catch {
    return DEFAULT_GITS_CHAT_PREFS;
  }
}

function equals(a: GitsChatPrefs, b: GitsChatPrefs) {
  return (
    a.theme === b.theme &&
    a.accent === b.accent &&
    a.reduceGlow === b.reduceGlow &&
    a.typeSound === b.typeSound
  );
}

function getSnapshot(): GitsChatPrefs {
  if (!hasStorage()) return DEFAULT_GITS_CHAT_PREFS;
  const next = parse(localStorage.getItem(STORAGE_KEY));
  if (equals(lastSnapshot, next)) return lastSnapshot;
  lastSnapshot = next;
  return lastSnapshot;
}

function getServerSnapshot(): GitsChatPrefs {
  return DEFAULT_GITS_CHAT_PREFS;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) for (const l of listeners) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

function write(next: GitsChatPrefs) {
  if (!hasStorage()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  for (const l of listeners) l();
}

export function useGitsChatPrefs() {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setPref = useCallback(<K extends keyof GitsChatPrefs>(key: K, value: GitsChatPrefs[K]) => {
    write({ ...getSnapshot(), [key]: value });
  }, []);
  return { prefs, setPref } as const;
}
