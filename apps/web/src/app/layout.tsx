import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { ThemeProvider, Toaster } from "@ago/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Office",
  description: "AI agents working together in a shared virtual office.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // proxy.ts puts the per-request CSP nonce here. Reading request headers also opts every route
  // into dynamic rendering, which a per-request nonce needs (prerendered HTML cannot carry one).
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    // suppressHydrationWarning: next-themes sets the theme class on <html> before first paint.
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
