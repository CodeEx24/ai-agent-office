"use client";

import { useState } from "react";

import { createSupabaseBrowserClient } from "../../../lib/supabase/browser";
import { createSupabaseOfficeSource } from "../realtime/supabase-office-source";
import { AgentCardGrid } from "./AgentCardGrid";
import type { AgentCardAgent } from "./AgentCard";

/**
 * The live agent cards: builds the Supabase event source once, as the signed-in user (row-level security applies),
 * from the PUBLIC settings the server page passes in. The grid itself takes any `OfficeEventSource`.
 */
export function OfficeCardsLive({
  workspaceId,
  agents,
  supabaseUrl,
  supabaseAnonKey,
}: {
  workspaceId: string;
  agents: readonly AgentCardAgent[];
  supabaseUrl: string;
  supabaseAnonKey: string;
}) {
  const [source] = useState(() =>
    createSupabaseOfficeSource(createSupabaseBrowserClient(supabaseUrl, supabaseAnonKey)),
  );
  return <AgentCardGrid workspaceId={workspaceId} agents={agents} source={source} />;
}
