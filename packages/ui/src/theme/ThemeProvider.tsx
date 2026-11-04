"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Wraps next-themes. It injects a tiny pre-paint script that sets the `dark` class on <html>
 * from localStorage or the system preference, so there is no flash. The root layout must set
 * `suppressHydrationWarning` on <html>.
 */
function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange {...props}>
      {children}
    </NextThemesProvider>
  );
}

export { ThemeProvider };
