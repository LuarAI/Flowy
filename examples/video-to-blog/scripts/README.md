# Scripts contract

Flowy ships none of these. They are yours. Each runs in the node's version
directory with `FLOWY_IN`, `FLOWY_OUT`, `FLOWY_NODE`, `FLOWY_RUN`, and one
`FLOWY_INPUT_<NAME>` per declared input. Exit non-zero on any failure; the
node is marked `failed` and the reason is `stderr.log`.

## `fetch_transcript.py <video>`

- Reads: nothing from `FLOWY_IN`.
- Writes: `FLOWY_OUT/transcript.md` (timestamped, `[mm:ss]` at least per
  paragraph) and `FLOWY_OUT/video.json` (`id`, `title`, `url`,
  `duration_s`, `published`).
- Typical implementations: a platform transcript API; `yt-dlp` + local
  Whisper; reading a cached transcript from a sources folder. Cache
  aggressively — transcribing is the slow step.

## `publish_post.py <blog_dir> <slug>`

- Reads: `FLOWY_IN/draft/post.md`, `FLOWY_IN/draft/approval.yaml`.
- Refuses (exit 2) unless `approval.yaml` has `approved: true`.
- Writes the post to `<blog_dir>/<slug>.md` (suffix `-2`, `-3` if taken)
  and `FLOWY_OUT/published.json` (`slug`, `path`, `bytes`).

## `update_catalog.py <blog_dir>`

- Reads: `FLOWY_IN/post/<slug>/publish/published.json` for each item, and
  `<blog_dir>` itself.
- Writes whatever index your blog needs, and `FLOWY_OUT/catalog.json`
  (`posts_total`, `posts_added[]`, `seeds_added`).
