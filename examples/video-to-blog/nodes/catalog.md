---
id: catalog
title: Rebuild catalog
mode: script
needs: [post]
run: python scripts/update_catalog.py "{{inputs.blog_dir}}"
outputs: [catalog.json]
timeout: 5m
---

Runs once every post item is `done` or `skipped`. Regenerates whatever index
the blog keeps (a catalog file, a sitemap, cross-links) from `blog_dir`, and
writes a summary to `out/catalog.json`:

```json
{ "posts_total": 41, "posts_added": ["slug-a", "slug-b"], "seeds_added": 1 }
```

`in/post/<slug>/publish/published.json` exists for each item that was
published; `in/post/<slug>/status` is `skipped` for the ones the human
declined. The script may use either.
