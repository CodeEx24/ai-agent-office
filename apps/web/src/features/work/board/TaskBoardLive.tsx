"use client";

import { useState } from "react";

import { createSupabaseBrowserClient } from "../../../lib/supabase/browser";
import { createSupabaseOfficeSource } from "../../office/realtime/supabase-office-source";
import type { BoardData } from "./board-types";
import { loadBoardData } from "./load-board-data";
import { TaskBoard } from "./TaskBoard";

/**
 * The live task board: builds the Supabase client once, as the signed-in user (row-level security applies), from the
 * PUBLIC settings the server page passes in. The same client feeds the realtime source (run state) and the poll
 * (tasks, runs, approvals). `initial` is the server's first read, or null when it failed.
 */
export function TaskBoardLive({
  workspaceId,
  initial,
  supabaseUrl,
  supabaseAnonKey,
}: {
  workspaceId: string;
  initial: BoardData | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
}) {
  const [client] = useState(() => createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey));
  const [source] = useState(() => createSupabaseOfficeSource(client));
  const [load] = useState(() => () => loadBoardData(client, workspaceId));
  return <TaskBoard workspaceId={workspaceId} source={source} initial={initial} load={load} />;
}
