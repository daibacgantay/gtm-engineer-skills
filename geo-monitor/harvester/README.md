# geo-harvester (spike v0.1)

Scripted capture of **Google AI Overview** answers via CDP, writing
`rows.json` v2.2-compatible rows. It replaces the *manual* MCP-driven typing
loop for the one engine whose prompts can travel as URLs — Google.

This is a spike: the whole directory is removable (`rm -rf`) and SKILL.md
manual pilot remains the fallback for every engine. Nothing here is installed
into the skill contract yet.

## Why

The pilot run at 30 prompts × 5 engines ≈ 150 captures is dominated by
wait-for-stream time, and each capture costs an LLM round-trip when driven via
chrome-devtools MCP. Google AIO needs no typing at all — the prompt *is* a
URL. Scripting it moves the wait out of the agent loop entirely and enables a
small pool of concurrent tabs.

## How

- **Connect-only.** `chromium.connectOverCDP` into the already-running,
  already-logged-in pilot Chrome (`--user-data-dir=gtm-pilot-chrome`, default
  `http://127.0.0.1:9222`; point `--cdp` elsewhere if the port moved).
  It never launches a browser, never binds/kills the debugging port.
- **Measurement laws honored:** one fresh search URL per prompt (never a
  follow-up); alias scan only over the captured AIO slice; failed cells get
  markers (`error`, `no_ai_overview`), never guesses; `web_queries` recorded
  raw from visible related-search chips (sentinel meaning unchanged).
- **Pace:** 2 tabs by default, random 8–16 s gap per tab after each run
  (AIO is search-style so it tolerates more parallelism than chat engines).
  On a CAPTCHA/"unusual traffic" page the run stops with exit code 2 —
  login/CAPTCHA is the human's job; resume later with `--resume`.
- **Rate-limit reality (learned 2026-10-03):** a burst of ~40 searches in
  ~40 min (smoke + 3-tab full run) tripped Google's `/sorry` "unusual
  traffic" page — it is **IP-wide** (personal browsing on google.com may
  also see the challenge until it clears, usually minutes–hours). Blocked
  pages are now detected (URL + VI/EN patterns) and cells become `error`,
  never a false `no_ai_overview`. For real runs prefer **2 tabs, 20–40 s
  gaps**; the block does not clear faster by retrying.
- **Output:** appends rows incrementally to `--out` (flush after every prompt),
  so a crash or Ctrl+C loses nothing already captured.

## Run

```
cd geo-monitor/harvester
npm install
node harvester.mjs ^
  --prompts  E:\Web\workspace\t-order-test\prompts.csv ^
  --aliases  "t-order,torder,torder.net" ^
  --out      E:\Web\workspace\t-order-test\monitor\rows_harvest_<YYYY-MM-DD>.json ^
  --limit 3 --tabs 2
```

Options: `--cdp <url>` `--limit N` `--tabs N` `--hl <lang>` `--timeout <s>`
`--no-aio-grace <s>` `--gap-min/--gap-max <s>` `--resume`.

The output is a **partial rows file** (google cells only). To feed the
dashboard, merge its google cells into the full dated `rows_<date>.json`
(keep every other engine's existing cell) — a one-off merge is done in the
weekly loop by the operator or a tiny script, never by overwriting the file.

## Known v0.1 gaps (by design for the spike)

- `sentiment` stays empty (needs judgment; a later step can fill it from
  `answer_text` without a browser).
- `position` uses the prose rule only; no list-position analysis.
- No evidence PNGs (render via `render_evidence.ps1` from `answer_text` as usual).
- Google only. The other four engines need per-engine DOM work before joining.
- `pages_cited` tags everything `(Google)`; correct today because only Google runs.
