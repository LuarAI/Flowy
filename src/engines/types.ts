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
  addDirs: string[];
  /** The `engine.<name>` block from workflow.yaml, passed through. */
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onEvent: (e: TraceEvent) => void;
}

export interface EngineResult {
  exitCode: number;
  sessionId: string | null;
  costUsd: number | null;
  tokens: { input: number; output: number; cache_read: number } | null;
  turns: number | null;
  structuredOutput: unknown;
  error: string | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface InteractiveJob {
  cwd: string;
  /** Absolute path of prompt.md in cwd; engines open the session pointing at it. */
  promptFile: string;
  resumeSession: string | null;
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
    error: null,
    timedOut: false,
    aborted: false,
  };
}
