#!/usr/bin/env node
/**
 * geo-harvester v0.1 (spike) — scripted Google AI Overview capture over CDP.
 *
 * Attaches to the ALREADY-RUNNING pilot Chrome (connect-only; never launches,
 * never binds/kills the debugging port). Pulls prompts from a prompts.csv,
 * runs them in a small pool of tabs, and writes rows.json v2.2-compatible rows
 * (google cells: mentioned/position/answer_text/answer_links/web_queries).
 *
 * Honors geo-monitor measurement laws: one fresh conversation per prompt
 * (fresh search URL, never a follow-up), verdict computed only from the
 * captured AIO slice (never page-wide scans), raw capture with no
 * fabrication — failed cells get marker values, not guesses.
 *
 * Dead-end friendly: this directory is removable in one `rm -rf`; the pilot
 * manual (SKILL.md) remains the fallback path for every engine.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const AIO_MARKERS = [
	"AI Overview",
	"Overview of AI",
	"Tổng quan AI",
	"Thông tin tổng quan do AI tạo",
	"Tổng quan về AI",
	"AI-generated summary",
];
const RELATED_MARKERS = [
	"Related searches",
	"Related Queries",
	"Các tìm kiếm liên quan",
	"Tìm kiếm liên quan",
	"Mọi người cũng tìm kiếm",
	"Mọi người tìm kiếm",
];
const SELF_HOSTS = ["google.com", "gstatic.com", "googleusercontent.com"];
const BLOCK_PATTERN =
	/unusual traffic|lưu lượng truy cập bất thường|not a robot|CAPTCHA|verify you are a human|kiểm tra xem bạn có đúng là người/i;

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith("--") ? true : v;
}

const OPT = {
	cdp: arg("cdp", "http://127.0.0.1:9222"),
	prompts: arg("prompts", undefined),
	aliases: arg("aliases", undefined),
	out: arg("out", undefined),
	limit: Number(arg("limit", "0")),
	tabs: Math.max(1, Number(arg("tabs", "1"))),
	hl: arg("hl", "vi"),
	timeoutMs: Number(arg("timeout", "90")) * 1000,
	noAioWaitMs: Number(arg("no-aio-grace", "15")) * 1000,
	gapMinMs: Number(arg("gap-min", "30")) * 1000,
	gapMaxMs: Number(arg("gap-max", "75")) * 1000,
	batch: Math.max(0, Number(arg("batch", "0"))),
	batchGapMs: Number(arg("batch-gap", "240")) * 1000,
	resume: arg("resume", false) === true,
};

if (!OPT.prompts || !OPT.aliases || !OPT.out) {
	console.error(
		"usage: node harvester.mjs --prompts <csv> --aliases \"a,b,c\" --out <rows.json> " +
			"[--cdp http://127.0.0.1:9222] [--limit N] [--tabs 1] [--hl vi] [--timeout 90] " +
			"[--gap-min 30] [--gap-max 75] [--batch N] [--batch-gap 240] [--resume]",
	);
	process.exit(1);
}

if (OPT.tabs > 1) {
	console.error(
		"[harvest] WARNING: concurrent AIO tabs tripped Google's IP-level 'unusual traffic' block " +
			"on 2026-10-03. The manual round-robin never did because each engine saw one query every " +
			"few minutes. Prefer --tabs 1 with gap pacing; only raise it if verified safe for this IP/account.",
	);
}

// ---------------------------------------------------------------- prompts.csv
function parseCsv(text) {
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else cell += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(cell);
			cell = "";
		} else if (c === "\n") {
			row.push(cell.replace(/\r$/, ""));
			rows.push(row);
			row = [];
			cell = "";
		} else if (c !== "\r") cell += c;
	}
	if (cell !== "" || row.length > 0) {
		row.push(cell.replace(/\r$/, ""));
		rows.push(row);
	}
	return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function loadPrompts(file) {
	const raw = parseCsv(readFileSync(file, "utf8").replace(/^/, ""));
	const header = raw[0].map((h) => h.trim().toLowerCase());
	const pi = header.indexOf("prompt");
	const pri = header.indexOf("priority");
	if (pi === -1) throw new Error(`${file}: missing 'prompt' column`);
	const out = [];
	for (const r of raw.slice(1)) {
		if (pri >= 0 && (r[pri] || "").trim().toLowerCase() === "skip") continue;
		const p = (r[pi] || "").trim();
		if (p) out.push(p);
	}
	return out;
}

// ---------------------------------------------------------------- verdict math
function verdict(text, aliases) {
	const low = text.toLowerCase();
	let idx = -1;
	for (const a of aliases) {
		const i = low.indexOf(a.toLowerCase());
		if (i !== -1 && (idx === -1 || i < idx)) idx = i;
	}
	if (idx === -1) return { mentioned: "no", position: "" };
	const words = text.slice(0, idx).split(/\s+/).filter(Boolean).length;
	const total = Math.max(text.split(/\s+/).filter(Boolean).length, 1);
	const ratio = words / total;
	return { mentioned: "yes", position: ratio <= 1 / 3 ? "top" : ratio <= 2 / 3 ? "middle" : "bottom" };
}

function cleanLinks(links) {
	const seen = new Set();
	const out = [];
	for (const raw of links) {
		let url = raw;
		try {
			const u = new URL(raw);
			if (u.protocol !== "http:" && u.protocol !== "https:") continue;
			const host = u.hostname.toLowerCase().replace(/^www\./, "");
			if (SELF_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
			u.search = "";
			u.hash = "";
			url = u.toString();
		} catch {
			continue;
		}
		if (seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

// ---------------------------------------------------------------- browser side
async function extractAio(page) {
	return page.evaluate(
		({ aioMarkers, relatedMarkers }) => {
			const leafMatches = (el, markers) => {
				if (el.children.length > 0) return false;
				const t = (el.textContent || "").trim().toLowerCase();
				if (!t || t.length > 80) return false;
				return markers.some((m) => t.startsWith(m.toLowerCase()));
			};
			const findContainer = (markers, minLen) => {
				const els = document.querySelectorAll("div, section");
				for (const el of els) {
					if (!leafMatches(el, markers)) continue;
					let node = el;
					for (let hop = 0; hop < 10 && node; hop++) {
						const len = (node.innerText || "").length;
						if (len >= minLen && len <= 15000) return node;
						node = node.parentElement;
					}
					return el.closest("div, section") || el.parentElement || el;
				}
				return null;
			};
			const aio = findContainer(aioMarkers, 400);
			if (!aio) return null;
			const text = (aio.innerText || "").trim();
			if (!text) return null;
			const links = [...aio.querySelectorAll("a[href^='http']")].map((a) => a.href);
			const chips = [];
			const rel = findContainer(relatedMarkers, 10);
			if (rel) {
				const scope = rel.closest("div, section") || rel;
				for (const line of (scope.innerText || "").split("\n")) {
					const t = line.trim();
					if (t && !relatedMarkers.some((m) => t.toLowerCase().startsWith(m.toLowerCase()))) chips.push(t);
				}
			}
			return { text, links, chips };
		},
		{ aioMarkers: AIO_MARKERS, relatedMarkers: RELATED_MARKERS },
	);
}

async function pageLooksBlocked(page) {
	if (/\/sorry\//.test(page.url())) return true;
	const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000));
	return BLOCK_PATTERN.test(text);
}

/** Distinguishes a real (if AIO-less) SERP from a failed/blank/consent page. */
async function pageHasSearchResults(page) {
	return page.evaluate(() => {
		if (document.querySelector("#rso, #search, #rcnt, #botstuff")) return true;
		return (document.body?.innerText || "").length > 800;
	});
}

async function runPrompt(page, prompt) {
	const url = `https://www.google.com/search?q=${encodeURIComponent(prompt)}&hl=${OPT.hl}`;
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
	await page.waitForTimeout(2500);
	if (await pageLooksBlocked(page)) throw new Error("BLOCKED_CAPTCHA");
	if (!(await pageHasSearchResults(page))) throw new Error("NO_RESULTS_PAGE");

	const started = Date.now();
	let last = null;
	let lastLen = -1;
	let stableSince = 0;
	while (Date.now() - started < OPT.timeoutMs) {
		await page.mouse.wheel(0, 400).catch(() => {});
		const data = await extractAio(page);
		if (data) {
			last = data;
			if (data.text.length === lastLen && Date.now() - stableSince >= 4000) break;
			if (data.text.length !== lastLen) {
				lastLen = data.text.length;
				stableSince = Date.now();
			}
		} else if (Date.now() - started > OPT.noAioWaitMs) {
			last = null;
			break;
		}
		await page.waitForTimeout(2000);
	}
	if (!last) return { status: "no_ai_overview" };
	const truncated = Date.now() - stableSince < 4000;
	return { status: "ok", data: last, truncated };
}

// ---------------------------------------------------------------- orchestration
function emptyCell(why) {
	return { mentioned: why, position: "", sentiment: "", img: null };
}

function buildRow(prompt, result, aliases) {
	if (result.status === "no_ai_overview") {
		return {
			prompt,
			branded: false,
			engines: { google: { ...emptyCell("no_ai_overview"), note: "harvest v0.1: no AIO block" } },
			any_mentioned: "no",
			pages_cited: [],
			notes: `harvested v0.1 (google) ${new Date().toISOString()}`,
		};
	}
	const { data } = result;
	const v = verdict(data.text, aliases);
	const links = cleanLinks(data.links);
	const row = {
		prompt,
		branded: false,
		engines: {
			google: {
				mentioned: v.mentioned,
				position: v.position,
				sentiment: "",
				answer_text: data.text,
				answer_links: links,
				web_queries: data.chips,
				img: null,
			},
		},
		any_mentioned: v.mentioned,
		pages_cited: links.map((u) => `${u} (Google)`),
		notes: `harvested v0.1 (google)${result.truncated ? " TRUNCATED: stream not stable" : ""} ${new Date().toISOString()}`,
	};
	return row;
}

async function main() {
	const aliases = OPT.aliases
		.split(",")
		.map((a) => a.trim().toLowerCase())
		.filter(Boolean);
	if (aliases.length === 0) throw new Error("--aliases must list at least one alias");

	let prompts = loadPrompts(resolve(OPT.prompts));
	if (OPT.limit > 0) prompts = prompts.slice(0, OPT.limit);

	const outFile = resolve(OPT.out);
	const rows = [];
	const done = new Map();
	if (OPT.resume && existsSync(outFile)) {
		for (const r of JSON.parse(readFileSync(outFile, "utf8"))) {
			const cell = r.engines?.google;
			if (cell && ["yes", "no", "no_ai_overview"].includes(cell.mentioned)) {
				done.set(r.prompt, r);
				rows.push(r);
			}
		}
	}
	const queue = prompts.filter((p) => !done.has(p));
	console.error(`[harvest] ${prompts.length} prompts (${done.size} resumed, ${queue.length} pending) × ${OPT.tabs} tabs`);

	if (queue.length === 0) {
		console.error("[harvest] nothing to run");
		return 0;
	}

	const browser = await chromium.connectOverCDP(OPT.cdp);
	const context = browser.contexts()[0];
	const startedAt = Date.now();
	let completed = 0;
	let blocked = false;

	const flush = () => {
		writeFileSync(outFile, JSON.stringify(rows, null, 1), "utf8");
	};

	async function worker(idx) {
		const page = await context.newPage();
		await page.setViewportSize({ width: 1440, height: 900 });
		while (queue.length > 0 && !blocked) {
			const prompt = queue.shift();
			const t0 = Date.now();
			let row;
			try {
				const result = await runPrompt(page, prompt);
				row = buildRow(prompt, result, aliases);
			} catch (err) {
				if (String(err?.message).startsWith("BLOCKED_CAPTCHA")) {
					blocked = true;
					console.error(`[harvest] tab${idx}: BLOCKED_CAPTCHA — stopping run (human job, not the script's)`);
					break;
				}
				row = {
					prompt,
					branded: false,
					engines: { google: { ...emptyCell("error"), note: `harvest v0.1: ${String(err?.message).slice(0, 120)}` } },
					any_mentioned: "no",
					pages_cited: [],
					notes: `harvested v0.1 (google) ERROR ${new Date().toISOString()}`,
				};
			}
			rows.push(row);
			completed++;
			const m = row.engines.google.mentioned;
			const len = row.engines.google.answer_text?.length ?? 0;
			console.error(
				`[harvest] tab${idx} ${completed}/${prompts.length} (${Math.round((Date.now() - startedAt) / 1000)}s elapsed) ` +
					`"${prompt.slice(0, 44)}" → ${m}${m === "yes" ? "/" + row.engines.google.position : ""} len=${len} chips=${row.engines.google.web_queries?.length ?? 0}`,
			);
			flush();
			if (OPT.batch > 0 && completed % OPT.batch === 0 && queue.length > 0) {
				const pause = Math.round(OPT.batchGapMs * (0.8 + Math.random() * 0.4));
				console.error(`[harvest] batch pause ${Math.round(pause / 1000)}s after ${completed} runs`);
				await page.waitForTimeout(pause);
			} else {
				await page.waitForTimeout(OPT.gapMinMs + Math.random() * Math.max(0, OPT.gapMaxMs - OPT.gapMinMs));
			}
		}
		await page.close().catch(() => {});
	}

	try {
		await Promise.all(Array.from({ length: Math.min(OPT.tabs, queue.length) }, (_, i) => worker(i)));
	} finally {
		await browser.close().catch(() => {});
	}
	flush();
	const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
	console.error(
		`[harvest] done: ${completed} run in ${mins} min, ${blocked ? "STOPPED on CAPTCHA/blocked page — resume later with --resume; " : ""}rows → ${outFile}`,
	);
	return blocked ? 2 : 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`[harvest] fatal: ${err?.stack || err}`);
		process.exit(1);
	},
);
