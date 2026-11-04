"use client";

import { useSyncExternalStore } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "../components/Button";

const THEME_CYCLE = ["light", "dark", "system"] as const;
type ThemeName = (typeof THEME_CYCLE)[number];

const ICONS = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const;

function nextTheme(current: string | undefined): ThemeName {
  const index = THEME_CYCLE.indexOf((current ?? "system") as ThemeName);
  return THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? "light";
}

const subscribeNoop = () => () => {};

/** False during SSR and hydration, true after mount, so client-only values never cause a mismatch. */
function useIsMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Cycles light -> dark -> system. The stored theme is unknown on the server, so the icon and
 * label depend on it only after mount; before that a same-size placeholder keeps layout stable.
 */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isMounted = useIsMounted();
  const upcoming = nextTheme(theme);
  const Icon = ICONS[(theme as ThemeName | undefined) ?? "system"] ?? MonitorIcon;
  return (
    <Button
      variant="outline"
      size="icon"
      data-testid="theme-toggle"
      aria-label={isMounted ? `Switch to ${upcoming} theme` : "Toggle theme"}
      onClick={() => setTheme(upcoming)}
    >
      {isMounted ? <Icon /> : <span className="size-4" aria-hidden />}
    </Button>
  );
}

export { ThemeToggle, nextTheme };
