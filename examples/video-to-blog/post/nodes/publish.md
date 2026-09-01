---
id: publish
title: Publish
mode: script
needs: [draft]
run: python scripts/publish_post.py "{{inputs.blog_dir}}" "{{item.slug}}"
outputs: [published.json]
timeout: 2m
---

Copies the approved `in/draft/post.md` into the blog's posts folder under a
filename derived from `{{item.slug}}`, without overwriting an existing file
of the same name (append a numeric suffix and record it). Writes
`out/published.json`:

```json
{ "slug": "...", "path": "<absolute path written>", "bytes": 4321 }
```

Only runs when `in/draft/approval.yaml` has `approved: true`; the script
must exit non-zero otherwise, so a mis-approved item never publishes.
