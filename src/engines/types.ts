import type { TraceEvent } from "../core/types.js";

/** One headless agent run (SPEC §8). */
export interface EngineJob {
  cwd: string;
  prompt: string;
  tools: string[];
  outputs: string[];
  schema: Record<string, unknown> | null;
  timeoutMs: number;
  resumeSession: string | null;
  /** With resumeSession: continue as a NEW forked session, leaving the original untouched. */
  forkSession: boolean;
  addDirs: string[];
  /** The `engine.<name>` block from workflow.yaml, passed through. */
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onEvent: (e: TraceEvent) => void;
  /**
   * When set, tools outside the allowlist ask the human instead of being
   * denied: the engine routes permission prompts to this local endpoint
   * (Flowy's server), which surfaces them in the chat card.
   */
  permissionPrompt?: { url: string; token: string };
}

export interface EngineResult {
  exitCode: number;
  sessionId: string | null;
  costUsd: number | null;
  tokens: { input: number; output: number; cache_read: number } | null;
  turns: number | null;
  structuredOutput: unknown;
  /** The engine's final answer text, when it reports one (used by crystallization). */
  text: string | null;
  error: string | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface InteractiveJob {
  cwd: string;
  /** Absolute path of prompt.md in cwd; engines open the session pointing at it. */
  promptFile: string;
  resumeSession: string | null;
  /** Ask the engine to use this session id, so the conversation can be resumed later. */
  sessionId: string | null;
  addDirs: string[];
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

export type Capability = "structured_output" | "resume" | "thinking" | "subagent_trace" | "cost";

export interface Engine {
  name: string;
  capabilities: Capability[];
  run(job: EngineJob): Promise<EngineResult>;
  /** Open an interactive session in `cwd` (chat mode). Resolves with the exit code. */
  interactive?(job: InteractiveJob): Promise<number>;
}

export function emptyResult(): EngineResult {
  return {
    exitCode: -1,
    sessionId: null,
    costUsd: null,
    tokens: null,
    turns: null,
    structuredOutput: undefined,
    text: null,
    error: null,
    timedOut: false,
    aborted: false,
  };
}
