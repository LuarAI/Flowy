/**
 * Template resolution (SPEC §1.2). Only these namespaces exist:
 *   {{inputs.<name>}}  {{item.<field>}}  {{run.id}} {{run.started}} {{run.seed}}
 *   {{workflow.dir}}   {{workflow.scripts}}
 */

export interface TemplateContext {
  inputs: Record<string, unknown>;
  run: { id: string; started: string; seed: number };
  item?: Record<string, unknown> | null;
  workflow: { dir: string; scripts: string };
}

const RE = /\{\{\s*([a-z]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

export class TemplateError extends Error {}

export function resolveTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(RE, (_m, ns: string, key: string) => {
    let v: unknown;
    switch (ns) {
      case "inputs":
        if (!(key in ctx.inputs)) throw new TemplateError(`unknown input "${key}"`);
        v = ctx.inputs[key];
        break;
      case "item":
        if (!ctx.item) throw new TemplateError(`{{item.${key}}} used outside a foreach`);
        if (!(key in ctx.item)) throw new TemplateError(`item has no field "${key}"`);
        v = ctx.item[key];
        break;
      case "run":
        if (!["id", "started", "seed"].includes(key)) throw new TemplateError(`unknown run field "${key}"`);
        v = (ctx.run as Record<string, unknown>)[key];
        break;
      case "workflow":
        if (!["dir", "scripts"].includes(key)) throw new TemplateError(`unknown workflow field "${key}"`);
        v = (ctx.workflow as Record<string, unknown>)[key];
        break;
      default:
        throw new TemplateError(`unknown template namespace "${ns}"`);
    }
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/** True if the string contains any template placeholder. */
export function hasTemplate(text: string): boolean {
  RE.lastIndex = 0;
  return RE.test(text);
}

/** Validate that every placeholder in `text` references a declared namespace/key where statically knowable. */
export function findTemplates(text: string): Array<{ ns: string; key: string }> {
  const out: Array<{ ns: string; key: string }> = [];
  for (const m of text.matchAll(RE)) out.push({ ns: m[1], key: m[2] });
  return out;
}
