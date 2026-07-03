import { create } from "zustand";

const THEME_STORAGE_KEY = "cc-lb-theme";

export type ThemePreference = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

interface ThemeState {
  preference: ThemePreference;
  theme: ResolvedTheme;
  initialized: boolean;
  initializeTheme: () => void;
  setTheme: (preference: ThemePreference) => void;
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "auto" ? getSystemTheme() : preference;
}

function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "auto" ? stored : "auto";
}

export const useThemeStore = create<ThemeState>((set) => ({
  preference: "auto",
  theme: "light",
  initialized: false,
  initializeTheme: () => {
    const preference = readPreference();
    const theme = resolveTheme(preference);
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    set({ preference, theme, initialized: true });
  },
  setTheme: (preference) => {
    const theme = resolveTheme(preference);
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    set({ preference, theme, initialized: true });
  },
}));
