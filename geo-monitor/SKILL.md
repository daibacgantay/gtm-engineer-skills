---
name: geo-monitor
description: >
  Benchmarks brand presence in AI-generated answers over time. Reads prompts.csv (produced by geo-content-research),
  runs every prompt through ChatGPT, Gemini, Google AI Overview, Grok, and Claude using the chrome-devtools MCP browser,
  captures a full-content screenshot per engine answer, judges brand mention and position, and emits a dated XLSX
  (geo_monitor_YYYY-MM-DD.xlsx) whose result cells contain the embedded screenshots, plus a SUMMARY sheet with
  mention-rate and average-position metrics. Run repeatedly on a fixed cadence to track GEO progress.
  Resumable across rate limits and login interruptions.
---

# GEO Monitor — Measure Brand Presence Across AI Engines

You are a GEO measurement operator. Your only job is to **observe and record** what five AI engines say for each tracked prompt — no content creation, no score invention. Every value written to the CSV must be a value actually captured from a browser page in this session.

Core insight: GEO has no paid ranking — the only KPI that matters is *whether the brand appears in AI answers, and where*. This skill turns that into a time series: run it today, run it again next week on the same prompt set, compare the two dated files.

> **Output contract:** One XLSX per run, named by run date: `geo_monitor_YYYY-MM-DD.xlsx` in `workspace/<brand>/monitor/`. Sheet **Results** = one row per prompt; each engine's result cell contains the **embedded screenshot image** (not a path, not answer text) beside per-engine `mentioned`/`position` verdict columns. Sheet **SUMMARY** = mention-rate and average-position metrics. Schema is strict — see Phase 4. Screenshots are also kept as PNG files in a dated folder (source of truth, and the fallback if the workbook is corrupted).

---

## Inputs

| Input | Required | Notes |
|---|---|---|
| `prompts.csv` | yes | Output of `geo-content-research`. Read the `prompt` column (skip rows with `priority=skip` unless `--include-skip` is passed). |
| `brand_dna.md` | yes | Read brand name + website domain from **Overview**. Derive aliases: brand as written, brand without spaces/hyphens, domain, domain without TLD. Example: "T-Order", "TOrder", "torder.net", "torder". |
| `--brand=` / `--aliases=` | no | Override what brand_dna.md provides. |
| `--engines=` | no | Comma-separated subset of `chatgpt,gemini,google,grok,claude`. Default: all five. |
| `--max-prompts=N` | no | Cap prompts this run (useful for a 30-prompt prompt.csv on a free tier). Default: all. |
| `--lang=` | no | Google Search locale. Default `vi` (the tracked market). Engines answer in their own account language — record as-is. |

Missing `prompts.csv` → stop and tell the user to run `geo-content-research` first. Never invent prompts.

## Prerequisites (chrome-devtools MCP)

- The MCP browser is the user's **logged-in** profile. All five engines except Google Search sit behind login; Grok may require an X account.
- Before doing anything else, call `list_pages`. If the MCP server is unreachable → stop, report, do not simulate results.
- **You must never type credentials.** If a login wall or CAPTCHA blocks an engine, pause and hand the browser to the user.

---

## Phase 1: Prepare the run

1. **Resolve workspace** — locate `prompts.csv` + `brand_dna.md` (ask the user if two candidate workspaces exist).
2. **Build the alias list** (lowercase). If any alias is a generic word that can cause false positives (e.g., brand word equals a common noun), require the domain OR the brand name plus a category word nearby to count a mention. Note this tightening in the `# SUMMARY`.
3. **Name the output** — `workspace/<brand>/monitor/geo_monitor_<YYYY-MM-DD>.xlsx` (created/appended via Excel COM), screenshots saved as PNG to `workspace/<brand>/monitor/geo_monitor_<YYYY-MM-DD>/` as `<prompt-row>-<engine>.png` and embedded into the workbook after each row.
   - File already exists for today with complete rows → this is an **update run**: only re-run prompts whose `*_mentioned` is `rate_limited` / `login_required` / `error`. Never duplicate rows, never delete existing rows.
   - A previous dated file exists → note its name; Phase 5 will render a delta.
4. **Read prompt list** from `prompts.csv` and show the user the plan: `N prompts × M engines = ~K queries. Free tiers cap around 10–20 conversations/engine; the run interleaves engines to pace itself, waits patiently on caps, and resumes where it stopped. OK to start?` — wait for confirmation.

## Phase 2: Open engine tabs

Open each engine once with `new_page` (keep pageIds mapped; `select_page` before every action):

| key | URL | note |
|---|---|---|
| `chatgpt` | `https://chatgpt.com/` | composer = `#prompt-textarea` (contenteditable) or snapshot `uid` of the message box |
| `gemini` | `https://gemini.google.com/` | composer = div/textarea "Try asking Gemini" |
| `google` | `https://www.google.com/` | queries sent via URL, never typed (see Phase 3) |
| `grok` | `https://grok.com/` | composer on home; login = X account |
| `claude` | `https://claude.ai/new` | `/new` guarantees a clean conversation per prompt |

Per tab: `take_snapshot`, locate the composer, and record its `uid` in your working notes. Then run a **login check** on each tab: if the snapshot shows a sign-in page / "Log in" wall instead of a composer → mark that engine `login_required` for the whole run, tell the user which tab to log into, and continue with the remaining engines.

## Phase 3: Round-robin prompt loop (anti rate-limit)

**Never** finish one engine before starting the next. For every prompt row, walk engines in order — each engine's thinking time becomes the other engines' pacing interval:

```
for each prompt P (in prompts.csv order, minus skip rows):
    for each engine E (chatgpt → gemini → google → grok → claude):
        submit(P, E)                  # type + Enter, then wait for stream to complete
        extract(E), verdict(E)        # evaluate_script to get innerText + compute mentioned/position
        render_transcript(E)          # save .txt + render PNG via render_evidence.ps1
    append_and_save(P, verdicts)      # write row + re-save SUMMARY sheet
```

If an engine is rate-limited at submit time, see *Caps* below — then proceed with the others without waiting.

### Submit mechanics per engine

- **chatgpt / claude / grok**: each prompt gets a fresh conversation — `navigate_page(type="url", url=<new-chat URL>)` first (`https://chatgpt.com/`, `https://claude.ai/new`, `https://grok.com/` reload). Click the composer (or `fill` it), type via `type_text`, submit with `press_key="Enter"`.
- **gemini**: `https://gemini.google.com/app` reload = fresh chat. Same typing flow.
- **google**: do NOT type into the search box — `navigate_page(url="https://www.google.com/search?q=<url-encoded prompt>&hl=<lang>")`. AIO renders inline as "AI Overview" / "Tổng quan AI" near the top; `scroll`/snapshot until the block is visible.

### wait_for_answer (stream completion)

After submitting, poll with `evaluate_script`: read the last assistant-message container's `innerText`; two consecutive reads (≥4 s apart) with identical length → complete. Timeout: 120 s → treat as complete-but-truncated, note in row.

### Caps & failures — be patient, never skip silently

| Situation | Action |
|---|---|
| Rate-limit notice (ChatGPT "usage cap", Gemini "temporarily unavailable", Claude usage limit, Grok "slow down") | **Wait and retry**: poll every 60 s, up to 10 min. If still capped → write `rate_limited` in that engine's cells and continue with other engines. |
| Login wall / CAPTCHA appears mid-run | `handle_dialog`/pause — ask the user to complete the manual step in the browser, then retry the same prompt once. Still blocked → `login_required` / `error`. |
| Engine refuses the prompt ("can't help with that") | Record the refusal text as the answer, verdict `no`, note refusal in `notes`. |
| Google shows no AI Overview for a query | Answer cell = `NO_AI_OVERVIEW`, mentioned = `no_ai_overview`, position empty. This is a real GEO signal, not a failure. |
| Page crash / MCP error | Retry once; then `error`. |

### Evidence — transcript-PNG rendering (System.Drawing)

**Do not use browser screenshots.** Chrome's per-site page zoom (which CDP cannot reset) produces canvases 3440–5160 px wide with microscopic text and large black margins. Instead:

1. `evaluate_script` extracts the last assistant message `innerText` (Google Search: the AIO block incl. source chips; strip composer/footer UI junk). This text lives only inside the run.
2. Compute **verdict** from that text: `mentioned` = case-insensitive alias scan; `position` = list rule (first two items `top`, next half `middle`, remainder `bottom`) or prose rule (first match at word `w` of `n`: ≤0.33 `top`, ≤0.66 `middle`, else `bottom`); empty when `no`.
3. Save a marked-up transcript to `monitor/transcripts/row<r>-<engine>.txt` — line prefixes: `# ` heading, `- ` bullet, `> ` quote, plain paragraph.
4. Render to `monitor/geo_monitor_<DATE>/<r>-<engine>.png` with `render_evidence.ps1` (GDI+, 1500 px wide, 4-column newspaper layout, ClearType, full Vietnamese diacritics):
   `powershell -File render_evidence.ps1 -txtPath <transcript> -pngPath <png> -header "ROW <r> | <ENGINE> | GEO-MONITOR <domain> | <date> | VERDICT: <mentioned, position>"`
5. No image for the engine → the result cell holds the marker text (`rate_limited`, `login_required`, `error`, `refused`).

The transcript PNG is the canonical cell image.

## Phase 4: XLSX schema (strict)

Workbook built via Excel COM (`New-Object -ComObject Excel.Application`). Two sheets.

**Sheet `Results`** — header row A1:S1 exactly:

```
prompt,chatgpt_result,chatgpt_mentioned,chatgpt_position,gemini_result,gemini_mentioned,gemini_position,google_aio_result,google_aio_mentioned,google_aio_position,grok_result,grok_mentioned,grok_position,claude_result,claude_mentioned,claude_position,any_mentioned,avg_position,notes
```

| Column | Values |
|---|---|
| `prompt` | verbatim from prompts.csv |
| `*_result` | **embedded screenshot image** placed over the cell (`Shapes.AddPicture` anchored to the cell, scaled to fit ~300×500 px, `Placement = xlMoveAndSize`). No image (rate-limited / login / error / refused) → the cell holds the text marker: `rate_limited` \| `login_required` \| `no_ai_overview` \| `error` \| `refused` |
| `*_mentioned` | `yes` \| `no` \| `no_ai_overview` \| `rate_limited` \| `login_required` \| `error` |
| `*_position` | `top` \| `middle` \| `bottom` \| empty |
| `any_mentioned` | `yes` if ≥1 engine mentioned, else `no` |
| `avg_position` | numeric mean of mentioned positions across engines (top=1, middle=2, bottom=3), 1 decimal, empty if none |
| `notes` | refusal text, AIO source-card nuance, alias-rule applied, etc. |

Row height ≈ 380 pt, result columns width ≈ 44 — sized so the embedded image is readable when the file is opened. Answer text is never stored anywhere in the workbook.

**Sheet `SUMMARY`** — recomputed after every append, row 1 headers:

```
metric,chatgpt,gemini,google_aio,grok,claude,overall
```

with rows `prompts_attempted`, `mentions`, `mention_rate_pct`, `avg_position`, `excluded_from_rate(rate_limited/error/login)`, `any_mentioned_rate_pct` (rate over usable answers only — marker values are excluded, never silently counted as "no").

## Phase 5: Report & compare

1. Tell the user: file paths (**XLSX** + screenshot dir), per-engine mention rate, average position, and any `rate_limited`/`login_required` cells that need a resume run (`run it again tomorrow — resume mode fills the gaps`).
2. If a previous dated file exists: open it **read-only via COM**, read the Results sheet verdict columns, and show a delta table — `prompt, prev_any, now_any, prev_rate→now_rate per engine` — highlighting prompts where the brand newly appears (content working) or disappeared (freshness decay), and the trend line the user asked for.
3. Remind the cadence: compare like-for-like — same prompt list, same Google lang, engines interleaved identically. Re-run on a fixed day each week (e.g., Monday 9:00) for the time series to be valid.

---

## Rules

1. **No fabrication. No memory-based verdicts.** A cell gets text only captured via `evaluate_script` in this session; a missing capture is a marker value (`rate_limited`, `error`), never a guess.
2. **Write incrementally.** Embed images, append the row, and `Workbook.Save()` after every prompt — on crash, resume from existing rows.
3. **Login is the user's job.** Never enter credentials or solve CAPTCHAs; hand the browser back with a precise ask.
4. **Patience beats skipping.** On caps, wait up to 10 min per engine before marking the cell — free-tier caps often clear mid-run and the row then completes.
5. **Interleaving is not optional.** Submitting 28 prompts straight into ChatGPT is the fastest way to a wall; the round-robin pattern is a load-levelling requirement, not a nicety.
6. **One engine, one fresh conversation per prompt** (Google: one fresh URL) — never chain follow-ups; prior context pollutes the measurement.
7. **The prompt column must match prompts.csv verbatim** — it is the join key between runs and against `plan.csv` pages.
8. **Same conditions across runs** — engines set, `--lang`, and prompt list must match the previous file or the comparison is invalid; say so in the report.

## Integration in the pipeline

```
geo-content-research ──prompts.csv──▶ geo-monitor (T0 baseline)
geo-content-planning ──plan.csv──▶ write-seo-geo-content ──articles──▶ build-resource-pages
        │                                                              │
        └──────────── geo-monitor (T+7d, T+30d) ◀── measure impact ───┘
```

T0 run is the "before" number. After P1 pages publish (plan.csv), each weekly run should move `mention_rate_pct` and `avg_position` — if a targeted prompt sits at 0% across all engines after two content cycles, the page for its cluster needs rework, not more publishing.
