
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "agent_capabilities": {
                  Row: {
                    "agent_id": string,"capability": string,"created_at": string,"granted_by": string | null,"id": string,"mode": string,"tier": number,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"capability": string,"created_at"?: string,"granted_by"?: string | null,"id"?: string,"mode"?: string,"tier"?: number,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string,"capability"?: string,"created_at"?: string,"granted_by"?: string | null,"id"?: string,"mode"?: string,"tier"?: number,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_capabilities_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "agent_capabilities_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_capabilities_workspace_id_granted_by_fkey"
      columns: ["workspace_id","granted_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"agent_credentials": {
                  Row: {
                    "agent_id": string,"capabilities": (string)[],"expires_at": string,"id": string,"issued_at": string,"revoked_at": string | null,"run_id": string,"token_hash": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"capabilities"?: (string)[],"expires_at": string,"id"?: string,"issued_at"?: string,"revoked_at"?: string | null,"run_id": string,"token_hash": string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string,"capabilities"?: (string)[],"expires_at"?: string,"id"?: string,"issued_at"?: string,"revoked_at"?: string | null,"run_id"?: string,"token_hash"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_credentials_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "agent_credentials_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_credentials_workspace_id_run_id_fkey"
      columns: ["workspace_id","run_id"]
isOneToOne: false
      referencedRelation: "runs"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"agent_identities": {
                  Row: {
                    "agent_id": string,"created_at": string,"id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"created_at"?: string,"id"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string,"created_at"?: string,"id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_identities_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: true
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "agent_identities_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"agent_skills": {
                  Row: {
                    "agent_id": string,"created_at": string,"id": string,"skill_id": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"created_at"?: string,"id"?: string,"skill_id": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string,"created_at"?: string,"id"?: string,"skill_id"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_skills_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "agent_skills_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_skills_workspace_id_skill_id_fkey"
      columns: ["workspace_id","skill_id"]
isOneToOne: false
      referencedRelation: "skills"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"agents": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"daily_budget_cents": number | null,"department_id": string | null,"description": string,"id": string,"mode": string,"model": string,"name": string,"prompt": string,"role": string,"status": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"daily_budget_cents"?: number | null,"department_id"?: string | null,"description"?: string,"id"?: string,"mode"?: string,"model"?: string,"name": string,"prompt"?: string,"role"?: string,"status"?: string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"daily_budget_cents"?: number | null,"department_id"?: string | null,"description"?: string,"id"?: string,"mode"?: string,"model"?: string,"name"?: string,"prompt"?: string,"role"?: string,"status"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agents_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"approvals": {
                  Row: {
                    "action": string,"agent_id": string,"consumed_at": string | null,"created_at": string,"decided_at": string | null,"decided_by": string | null,"department_id": string | null,"expires_at": string,"id": string,"payload_hash": string,"run_id": string | null,"status": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"agent_id": string,"consumed_at"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"department_id"?: string | null,"expires_at": string,"id"?: string,"payload_hash": string,"run_id"?: string | null,"status"?: string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "action"?: string,"agent_id"?: string,"consumed_at"?: string | null,"created_at"?: string,"decided_at"?: string | null,"decided_by"?: string | null,"department_id"?: string | null,"expires_at"?: string,"id"?: string,"payload_hash"?: string,"run_id"?: string | null,"status"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "approvals_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "approvals_workspace_id_decided_by_fkey"
      columns: ["workspace_id","decided_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "approvals_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "approvals_workspace_id_run_id_fkey"
      columns: ["workspace_id","run_id"]
isOneToOne: false
      referencedRelation: "runs"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"budgets_usage": {
                  Row: {
                    "agent_id": string | null,"cost_budget_cents": number | null,"cost_used_cents": number,"created_at": string,"id": string,"period_end": string,"period_start": string,"token_budget": number | null,"tokens_used": number,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id"?: string | null,"cost_budget_cents"?: number | null,"cost_used_cents"?: number,"created_at"?: string,"id"?: string,"period_end": string,"period_start": string,"token_budget"?: number | null,"tokens_used"?: number,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string | null,"cost_budget_cents"?: number | null,"cost_used_cents"?: number,"created_at"?: string,"id"?: string,"period_end"?: string,"period_start"?: string,"token_budget"?: number | null,"tokens_used"?: number,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budgets_usage_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "budgets_usage_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"capabilities": {
                  Row: {
                    "created_at": string,"default_mode": string,"description": string,"enabled": boolean,"id": string,"key": string,"name": string,"scope": string,"tier": number,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"default_mode": string,"description"?: string,"enabled"?: boolean,"id"?: string,"key": string,"name": string,"scope": string,"tier": number,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"default_mode"?: string,"description"?: string,"enabled"?: boolean,"id"?: string,"key"?: string,"name"?: string,"scope"?: string,"tier"?: number,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "capabilities_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"claims": {
                  Row: {
                    "agent_id": string,"claimed_at": string,"created_at": string,"expires_at": string | null,"id": string,"released_at": string | null,"run_id": string | null,"task_id": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"claimed_at"?: string,"created_at"?: string,"expires_at"?: string | null,"id"?: string,"released_at"?: string | null,"run_id"?: string | null,"task_id": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string,"claimed_at"?: string,"created_at"?: string,"expires_at"?: string | null,"id"?: string,"released_at"?: string | null,"run_id"?: string | null,"task_id"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "claims_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "claims_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "claims_workspace_id_run_id_fkey"
      columns: ["workspace_id","run_id"]
isOneToOne: false
      referencedRelation: "runs"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "claims_workspace_id_task_id_fkey"
      columns: ["workspace_id","task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"members": {
                  Row: {
                    "created_at": string,"id": string,"removed_at": string | null,"role": string,"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"removed_at"?: string | null,"role"?: string,"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"removed_at"?: string | null,"role"?: string,"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "members_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"notes_index": {
                  Row: {
                    "content_hash": string,"created_at": string,"department_id": string | null,"id": string,"indexed_at": string,"metadata": NonNullable<Json>,"path": string,"title": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content_hash"?: string,"created_at"?: string,"department_id"?: string | null,"id"?: string,"indexed_at"?: string,"metadata"?: NonNullable<Json>,"path": string,"title"?: string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "content_hash"?: string,"created_at"?: string,"department_id"?: string | null,"id"?: string,"indexed_at"?: string,"metadata"?: NonNullable<Json>,"path"?: string,"title"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notes_index_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"policies": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"created_by": string,"id": string,"level": string,"rule": NonNullable<Json>,"scope_id": string | null,"updated_at": string,"updated_by": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by": string,"id"?: string,"level": string,"rule": NonNullable<Json>,"scope_id"?: string | null,"updated_at"?: string,"updated_by": string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"created_by"?: string,"id"?: string,"level"?: string,"rule"?: NonNullable<Json>,"scope_id"?: string | null,"updated_at"?: string,"updated_by"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "policies_workspace_id_created_by_fkey"
      columns: ["workspace_id","created_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "policies_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "policies_workspace_id_updated_by_fkey"
      columns: ["workspace_id","updated_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"run_events": {
                  Row: {
                    "created_at": string,"id": string,"payload": NonNullable<Json>,"run_id": string,"seq": number,"type": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"payload"?: NonNullable<Json>,"run_id": string,"seq"?: number,"type": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"payload"?: NonNullable<Json>,"run_id"?: string,"seq"?: number,"type"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "run_events_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "run_events_workspace_id_run_id_fkey"
      columns: ["workspace_id","run_id"]
isOneToOne: false
      referencedRelation: "runs"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"runs": {
                  Row: {
                    "agent_id": string,"created_at": string,"finished_at": string | null,"id": string,"started_at": string | null,"status": string,"task_id": string | null,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"created_at"?: string,"finished_at"?: string | null,"id"?: string,"started_at"?: string | null,"status"?: string,"task_id"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string,"created_at"?: string,"finished_at"?: string | null,"id"?: string,"started_at"?: string | null,"status"?: string,"task_id"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "runs_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "runs_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "runs_workspace_id_task_id_fkey"
      columns: ["workspace_id","task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"skill_versions": {
                  Row: {
                    "body": string,"created_at": string,"created_by": string | null,"id": string,"skill_id": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"skill_id": string,"version": number,"workspace_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"skill_id"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "skill_versions_workspace_id_created_by_fkey"
      columns: ["workspace_id","created_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "skill_versions_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "skill_versions_workspace_id_skill_id_fkey"
      columns: ["workspace_id","skill_id"]
isOneToOne: false
      referencedRelation: "skills"
      referencedColumns: ["workspace_id","id"]
    }
                  ]
                },"skills": {
                  Row: {
                    "body": string,"created_at": string,"description": string,"id": string,"name": string,"updated_at": string,"version": number,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string,"created_at"?: string,"description"?: string,"id"?: string,"name": string,"updated_at"?: string,"version"?: number,"workspace_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"description"?: string,"id"?: string,"name"?: string,"updated_at"?: string,"version"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "skills_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "agent_id": string | null,"created_at": string,"created_by": string | null,"department_id": string | null,"description": string,"id": string,"status": string,"title": string,"updated_at": string,"workspace_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"department_id"?: string | null,"description"?: string,"id"?: string,"status"?: string,"title": string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "agent_id"?: string | null,"created_at"?: string,"created_by"?: string | null,"department_id"?: string | null,"description"?: string,"id"?: string,"status"?: string,"title"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_workspace_id_agent_id_fkey"
      columns: ["workspace_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "tasks_workspace_id_created_by_fkey"
      columns: ["workspace_id","created_by"]
isOneToOne: false
      referencedRelation: "members"
      referencedColumns: ["workspace_id","id"]
    },{
      foreignKeyName: "tasks_workspace_id_fkey"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "create_agent":
{ Args: { "p_capabilities": Json,"p_daily_budget_cents": number,"p_model": string,"p_name": string,"p_prompt": string,"p_role": string,"p_skill_ids": (string)[],"p_workspace_id": string }; Returns: string
                           },
"onboard_current_user":
{ Args: { "p_workspace_name": string }; Returns: string
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
