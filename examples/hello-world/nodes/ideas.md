---
id: ideas
title: Story ideas
mode: agent
tools: [Write]
outputs: [structured.json]
schema: schemas/ideas.schema.json
approve:
  notes: { type: string, description: "Guidance for the drafts (optional)" }
timeout: 5m
---

Propose exactly three short-story ideas about: {{inputs.topic}}.

Each idea needs a `slug` (kebab-case, 2–4 words), a `title` (≤ 6 words) and
a `premise` (one sentence, ≤ 30 words). Make the three genuinely different
in tone: one quiet, one strange, one funny.

Your final answer is the structured output; nothing else is needed.
