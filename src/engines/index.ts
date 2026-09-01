import { ClaudeEngine } from "./claude.js";
import { CodexEngine } from "./codex.js";
import { CustomEngine } from "./custom.js";
import { GeminiEngine } from "./gemini.js";
import { MockEngine } from "./mock.js";
import type { Engine } from "./types.js";

export class EngineRegistry {
  private engines = new Map<string, Engine>();

  constructor() {
    for (const e of [new ClaudeEngine(), new CodexEngine(), new GeminiEngine(), new CustomEngine(), new MockEngine()]) this.engines.set(e.name, e);
  }

  register(e: Engine): void {
    this.engines.set(e.name, e);
  }

  get(name: string): Engine {
    const e = this.engines.get(name);
    if (!e) throw new Error(`unknown engine "${name}" (known: ${[...this.engines.keys()].join(", ")})`);
    return e;
  }

  names(): string[] {
    return [...this.engines.keys()];
  }
}

export type { Engine, EngineJob, EngineResult, InteractiveJob } from "./types.js";
