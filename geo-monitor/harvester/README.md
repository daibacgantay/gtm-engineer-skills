# geo-harvester (spike v0.2)

Scripted capture of AI answers over CDP into the logged-in pilot Chrome,
writing `rows.json` v2.2-compatible rows. Engines: **google (AIO), chatgpt,
gemini, claude, grok**. The SKILL.md manual pilot remains the fallback and
the source of the per-engine mechanics (fresh conversation per prompt,
slice-only alias scanning, marker cells — never guesses).

This is a spike: the directory is removable (`rm -rf`), nothing is wired into
the skill contract yet, and the chat engines have NOT completed a live
validation run (see Status).

## Concurrency model — the lesson of 2026-10-03

**Parallel ACROSS engines, sequential WITHIN one engine.** Each engine gets
one worker tab running the prompt list one query at a time with randomized
human-like gaps (google ~30–75 s, chat engines ~90–180 s). That mirrors the
manual round-robin's rhythm, which never tripped a limit across T0 + re-runs.

A 3-tab burst against Google alone (~40 searches in ~40 min) hit Google's
**IP-wide** `/sorry` "unusual traffic" block AND escalated Cloudflare
challenges on chatgpt/claude/grok within the hour — personal browsing from
the same IP sees them too. They clear on their own (minutes to hours);
retrying does not speed that up.

Safeguards baked in:
- `/sorry` URL + VI/EN block patterns and blank-page/challenge detection →
  `error` cell, never a false `no_ai_overview`;
- login-wall detection → `login_required` cell (human's job);
- **circuit breaker**: an engine stops itself after 2 consecutive errors —
  it never grinds the whole list against a wall; other engines continue;
- every cell flushes to `--out` immediately; `--resume` skips cells that
  already have a terminal verdict and retries error/login cells.

## Run

```
cd geo-monitor/harvester
npm install
node harvester.mjs ^
  --prompts  E:\Web\workspace\t-order-test\prompts.csv ^
  --aliases  "t-order,torder,torder.net" ^
  --out      E:\Web\workspace\t-order-test\monitor\rows_harvest_<YYYY-MM-DD>.json ^
  --engines chatgpt,gemini --limit 1
```

Options: `--cdp <url>` (default `http://127.0.0.1:9222`; the pilot may sit on
another port — read `C:\Users\MAXSON\gtm-pilot-chrome\DevToolsActivePort`),
`--engines google,chatgpt,gemini,claude,grok` (default: google), `--limit N`,
`--hl vi`, `--timeout 180`, `--gap-min/--gap-max <s>` (override every
engine's built-in pacing), `--batch N --batch-gap <s>` (extra pause every N
runs per engine, for overnight jobs), `--resume`.

## Feeding the dashboard

The output is a **partial rows file** (only the engines that ran). To import
it alongside a full run, merge harvested cells into the complete
`rows_<date>.json` without ever overwriting it (importer join is verbatim on
prompt text — same prompts, so cells land on the right prompts). The merge
step is intentionally not written yet: finish live validation first.

## Status / known gaps

- **google**: validated live (verdicts matched the T0 cell on shared prompts);
  currently cooling down behind `/sorry` after the 2026-10-03 burst.
- **chatgpt/gemini/claude/grok**: drivers written from SKILL.md mechanics,
  zero live cells so far (the smoke attempt ran while the IP was already
  CF-challenged). Re-smoke 1 prompt/engine once challenges clear, then a
  full run before believing any numbers.
- `sentiment` stays empty (needs judgment; fill from `answer_text` later).
- `position` uses the prose rule only.
- No evidence PNGs / xlsx from the harvester (render from `answer_text` with
  `render_evidence.ps1` as usual).
- web_queries: google from visible chips (raw); chat engines apply the v2.2
  rule — links present but no visible searches → `["unavailable"]`, else `[]`.
