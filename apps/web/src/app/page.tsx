import { ThemeToggle } from "@ago/ui";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight text-primary">Agent Office</h1>
      <ThemeToggle />
    </main>
  );
}
