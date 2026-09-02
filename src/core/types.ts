/** Shared types for the Flowy runtime. See SPEC.md for the semantics. */

export type NodeMode = "agent" | "script" | "wait" | "chat";

export type InputType = "string" | "number" | "boolean" | "path" | "list";

export interface InputDecl {
  type: InputType;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export type ApproveType = "string" | "integer" | "number" | "boolean";

export interface ApproveField {
  type: ApproveType;
  required?: boolean;
  description?: string;
}

export interface RunCommand {
  windows?: string;
  posix?: string;
}

export interface NodeSpec {
  id: string;
  title: string;
  mode: NodeMode;
  needs: string[];
  context: string[];
  tools: string[];
  outputs: string[];
  schema: string | null;
  approve: Record<string, ApproveField> | null;
  lock: string | null;
  timeout: string;
  timeoutMs: number;
  cache: "inputs" | "never";
  before: string[];
  engine: string | null;
  model: string | null;
  effort: string | null;
  /** True once a chat node has crystallized: the body is the learned recipe and the node runs headless. */
  recipe: boolean;
  /** Branch semantics: this node resumes (a fork of) the named node's session, inheriting its conversation. */
  continues: string | null;
  run: string | RunCommand | null;
  hint: string | null;
  /** The markdown body: the prompt (agent/chat) or a description (script/wait). */
  body: string;
  /** Absolute path to the node file. */
  file: string;
  /** Absolute path to the workflow folder that owns this node. */
  workflowDir: string;
  /** Set when the node lives inside a foreach's nested workflow. */
  foreach: string | null;
}

export interface ForeachSpec {
  id: string;
  /** `<node>.<key>` split. */
  source: { node: string; key: string };
  workflowDir: string;
  key: string | null;
  concurrency: number;
  /** Nested node ids in declaration order. */
  nodes: string[];
  /** Implicit top-level dependencies: the source node plus everything nested nodes reference. */
  needs: string[];
}

export interface EngineConfig {
  default: string;
  [engine: string]: unknown;
}

export interface Edge {
  from: string;
  to: string;
}

export interface Manifest {
  flowy: number;
  name: string;
  description: string;
  dir: string;
  compiledAt: string;
  inputs: Record<string, InputDecl>;
  engine: EngineConfig;
  concurrency: number;
  stagger_ms: number;
  link_threshold: number;
  locks: Record<string, number>;
  /** All nodes, top-level and nested, keyed by id. */
  nodes: Record<string, NodeSpec>;
  foreach: Record<string, ForeachSpec>;
  /** Top-level order: node ids and foreach ids. */
  top: string[];
  /** Edges among top-level vertices (foreach ids count as vertices) and within nested workflows. */
  edges: Edge[];
}

export interface RunInfo {
  id: string;
  workflow: string;
  workflowDir: string;
  /** Absolute path of runs/<id>. */
  dir: string;
  started: string;
  seed: number;
  inputs: Record<string, unknown>;
  status: "idle" | "running" | "done" | "failed";
}

export type ResultStatus =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "blocked"
  | "interrupted"
  | "missing_output"
  | "schema_invalid"
  | "timeout";

export interface OutputInfo {
  bytes: number;
  sha256: string;
}

export interface NodeResult {
  node: string;
  version: string;
  mode: NodeMode;
  engine: string | null;
  status: ResultStatus;
  started: string;
  ended: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  session_id: string | null;
  cost_usd: number | null;
  tokens: { input: number; output: number; cache_read: number } | null;
  turns: number | null;
  outputs: Record<string, OutputInfo>;
  meta: Record<string, unknown>;
  error: string | null;
}

/** Status as derived for display and scheduling (SPEC §6.4, §13). */
export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "gate"
  | "waiting"
  | "done"
  | "cached"
  | "stale"
  | "failed"
  | "blocked"
  | "interrupted"
  | "missing_output"
  | "schema_invalid"
  | "timeout"
  | "skipped"
  | "orphaned";

export type ItemState = "pending" | "running" | "done" | "skipped" | "orphaned";

export interface NodeAddr {
  node: string;
  item?: { foreach: string; id: string };
}

export interface TraceEvent {
  t: string;
  type:
    | "start"
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "retry"
    | "subagent"
    | "stdout"
    | "stderr"
    | "end";
  engine: string;
  payload: unknown;
}

export interface Approval {
  [field: string]: unknown;
  _approved_at: string;
  _approved_by: string;
}
