"use client";

import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ThemeToggle,
  toast,
} from "@ago/ui";

const AGENTS = [
  { name: "Pixel", role: "Office assistant", state: "Working" },
  { name: "Scout", role: "Researcher", state: "Idle" },
  { name: "Ledger", role: "Bookkeeper", state: "Waiting for approval" },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} data-testid={`gallery-${id}`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function UiGallery() {
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-10 p-6 sm:p-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">UI gallery</h1>
          <p className="text-muted-foreground">Base components from @ago/ui. Development only.</p>
        </div>
        <ThemeToggle />
      </header>

      <Section id="button" title="Button">
        <div className="flex flex-wrap gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">Destructive</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section id="card" title="Card">
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Pixel</CardTitle>
            <CardDescription>Android office assistant</CardDescription>
          </CardHeader>
          <CardContent>Drafting the weekly summary for the team.</CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Open</Button>
            <Button size="sm" variant="outline">
              Pause
            </Button>
          </CardFooter>
        </Card>
      </Section>

      <Section id="dialog" title="Dialog">
        <div>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Approve this action?</DialogTitle>
                <DialogDescription>A human decides. Agents cannot approve their own requests.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Approve</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </Section>

      <Section id="sonner" title="Sonner (toast)">
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => toast("Agent paused")}>
            Default toast
          </Button>
          <Button variant="outline" onClick={() => toast.success("Run completed")}>
            Success toast
          </Button>
          <Button variant="outline" onClick={() => toast.error("Run failed")}>
            Error toast
          </Button>
        </div>
      </Section>

      <Section id="command" title="Command">
        <Command className="max-w-md rounded-lg border shadow-sm">
          <CommandInput placeholder="Search agents and actions..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Agents">
              {AGENTS.map((agent) => (
                <CommandItem key={agent.name}>{agent.name}</CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Actions">
              <CommandItem>
                New agent <CommandShortcut>N</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
        <div>
          <Button variant="outline" onClick={() => setIsPaletteOpen(true)}>
            Open command dialog
          </Button>
          <CommandDialog open={isPaletteOpen} onOpenChange={setIsPaletteOpen}>
            <CommandInput placeholder="Type a command..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Go to">
                <CommandItem>Approvals</CommandItem>
                <CommandItem>Vault</CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </div>
      </Section>

      <Section id="table" title="Table">
        <Table>
          <TableCaption>Agents in the office</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {AGENTS.map((agent) => (
              <TableRow key={agent.name}>
                <TableCell className="font-medium">{agent.name}</TableCell>
                <TableCell>{agent.role}</TableCell>
                <TableCell>{agent.state}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section id="tabs" title="Tabs">
        <Tabs defaultValue="overview" className="max-w-md">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">Overview panel</TabsContent>
          <TabsContent value="activity">Activity panel</TabsContent>
          <TabsContent value="memory">Memory panel</TabsContent>
        </Tabs>
      </Section>
    </main>
  );
}
