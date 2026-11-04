"use client";

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

/** Cycles light -> dark -> system. The label always names the theme that will be applied next. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const upcoming = nextTheme(theme);
  const Icon = ICONS[(theme as ThemeName | undefined) ?? "system"] ?? MonitorIcon;
  return (
    <Button
      variant="outline"
      size="icon"
      data-testid="theme-toggle"
      aria-label={`Switch to ${upcoming} theme`}
      suppressHydrationWarning
      onClick={() => setTheme(upcoming)}
    >
      <Icon />
    </Button>
  );
}

export { ThemeToggle, nextTheme };
