import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider, Toaster } from "@ago/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Office",
  description: "AI agents working together in a shared virtual office.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html> before first paint.
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
