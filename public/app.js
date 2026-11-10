// gh.bioinfolder.com front end. A keyboard-driven triage list (SPEC 13). PRs: status tabs +
// repo filter over /api/inbox (SPEC 5);
// Issues: /api/issues (SPEC 11). Old and Hidden fold at the bottom. Push setup (SPEC 7).
// PR/issue text comes from GitHub and is untrusted: everything goes in via textContent.
const $ = (s) => document.querySelector(s);
// this script's own version (its ?v= hash); the server reports the current one
const VERSION = new URL(import.meta.url).searchParams.get("v");
const main = $("#main");

// view state; remembered per device (a convenience only, so failures are ignored)
const saved = (() => { try { return JSON.parse(localStorage.getItem("ghd-view") || "{}"); } catch { return {}; } })();
const view = { kind: saved.kind || "pr", tab: saved.tab || "needs_you", repo: saved.repo || "", sel: null, expanded: false, folds: {} };
const remember = () => { try { localStorage.setItem("ghd-view", JSON.stringify({ kind: view.kind, tab: view.tab, repo: view.repo })); } catch {} };
let data = { pr: null, issue: null, login: "" };

function el(tag, attrs = {}, ...kids) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "onclick") e.addEventListener("click", v);
		else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
	}
	for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
	return e;
}

function toast(msg) {
	const t = $("#toast");
	t.textContent = msg;
	t.style.display = "block";
	clearTimeout(toast.t);
	toast.t = setTimeout(() => (t.style.display = "none"), 4000);
}

async function api(path, body) {
	const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
	return { status: r.status, data: await r.json().catch(() => ({})) };
}

function age(iso) {
	const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
	if (m < 60) return `${Math.round(m)}m`;
	if (m < 1440) return `${Math.round(m / 60)}h`;
	return `${Math.round(m / 1440)}d`;
}

const CHECKS = { success: ["✓", "checks passed"], failure: ["✗", "checks failed"], pending: ["●", "checks running"], none: ["–", "no checks"] };
const REVIEW = { APPROVED: ["✓", "approved"], CHANGES_REQUESTED: ["✎", "changes requested"], REVIEW_REQUIRED: ["○", "review required"] };
const PR_TABS = [["needs_you", "Needs you"], ["waiting", "WIP"], ["ci_failing", "CI failing"], ["all", "All"]];
// row tint by the section a PR sits in (SPEC 5), so "All" still shows what needs you
const TONE = { needs_you: "you", ci_failing: "bad", waiting: "wait" };
const byRepo = (xs) => (view.repo ? xs.filter((x) => x.repo === view.repo) : xs);
const keyOf = (x) => `${x.repo}#${x.number}`;
const stale = (x) => Date.now() - Date.parse(x.updatedAt) > (data.pr?.staleDays ?? 3) * 86400000;
const busy = (fn) => async (e) => {
	const b = e?.target?.closest?.("button");
	if (b) b.disabled = true;
	try { await fn(); } finally { if (b) b.disabled = false; }
};

async function doAction(pr, action, extra = {}) {
	const { status, data: d } = await api(`/api/prs/${action}`, { repo: pr.repo, number: pr.number, ...extra });
	if (status === 200) {
		toast({ merge: "Merged", approve: "Approved", rerun: "Re-running failed checks", comment: "Comment posted" }[action]);
		setTimeout(load, 1500);
	} else toast(d.error || `Failed (${status})`);
}

async function setHidden(kind, item, hide) {
	const { status } = await api(hide ? "/api/hide" : "/api/unhide", { kind, repo: item.repo, number: item.number });
	if (status === 200) {
		toast(hide ? "Hidden until something new happens" : "Back in the list");
		load();
	} else toast(`Failed (${status})`);
}

// SPEC 12: AI summaries shown on this page, by "kind:repo#n" (kept across re-renders)
const summaries = new Map();
// model text -> nodes: **bold** dropped to plain, `code` kept as <code>; never HTML
const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").split(/`([^`]+)`/).map((part, i) => (i % 2 ? el("code", {}, part) : part));

// SPEC 12: summaries being streamed in, "kind:repo#n" -> "reading" | "writing"
const streaming = new Map();

function summaryBox(kind, item) {
	const k = `${kind}:${keyOf(item)}`;
	const s = summaries.get(k) ?? "";
	const stage = streaming.get(k);
	const live = stage !== undefined ? " streaming" : "";
	const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
	const bullet = (l) => l.replace(/^[-*•]\s*/, "");
	// SPEC 12: labelled rows (What, Key points, Status, Next); "- " lines under a label are its list
	const LABEL = /^(What|Key points|Status|Next):\s*(.*)$/i;
	// while streaming, wait until the first line shows which form it takes
	if (live && !LABEL.test(lines[0] ?? "") && !/^[-*•]\s/.test(lines[0] ?? "")) {
		return el("div", { class: "summary streaming pending", role: "status", "data-summary": k },
			stage === "reading" ? `Reading the ${kind === "pr" ? "PR" : "issue"}…` : "Writing…");
	}
	if (!s) return null;
	if (LABEL.test(lines[0] ?? "")) {
		const rows = [];
		for (const l of lines) {
			const m = l.match(LABEL);
			if (m) rows.push({ label: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), text: m[2], items: [] });
			else if (/^[-*•]\s/.test(l)) rows.at(-1).items.push(bullet(l));
			else rows.at(-1).text += ` ${l}`;
		}
		return el("dl", { class: `summary${live}`, "data-summary": k }, rows.flatMap((r) => [el("dt", {}, r.label),
			el("dd", {}, r.text ? el("p", {}, inline(r.text)) : null, r.items.length ? el("ul", {}, r.items.map((i) => el("li", {}, inline(i)))) : null)]));
	}
	// a summary kept in the older bullet form shows as a list
	return el("div", { class: `summary${live}`, "data-summary": k }, el("ul", {}, lines.map((l) => el("li", {}, inline(bullet(l))))));
}

// while text streams in, redraw only that summary, at most once a frame, so the row's
// buttons stay put under a finger
const painting = new Set();
function paint(kind, item) {
	const k = `${kind}:${keyOf(item)}`;
	if (painting.has(k)) return;
	painting.add(k);
	requestAnimationFrame(() => {
		painting.delete(k);
		const old = main.querySelector(`[data-summary="${CSS.escape(k)}"]`);
		const box = summaryBox(kind, item);
		if (old && box) old.replaceWith(box);
		else if (!old) render();
	});
}

// SPEC 12, 17: a model's answer as server-sent events: stage, text pieces ("message"),
// then done or error. A refusal before the stream starts comes back as JSON.
async function streamPost(path, body, onEvent) {
	const r = await fetch(path, {
		method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body),
	});
	if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const d = await r.json().catch(() => ({}));
		throw new Error(d.error || `Failed (${r.status})`);
	}
	const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	for (let done = false; !done;) {
		const chunk = await reader.read();
		done = chunk.done;
		buf += chunk.value ?? "";
		let end;
		while ((end = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, end);
			buf = buf.slice(end + 2);
			const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
			const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? "null");
			if (event === "error") throw new Error(data.error);
			onEvent(event, data);
		}
	}
}

// SPEC 12: the summary as server-sent events: stage, text pieces, then done or error
async function summarize(kind, item) {
	const k = `${kind}:${keyOf(item)}`;
	if (streaming.has(k)) return;
	streaming.set(k, "reading");
	summaries.set(k, "");
	view.expanded = true;
	render();
	try {
		await streamPost("/api/summarize", { kind, repo: item.repo, number: item.number }, (event, data) => {
			if (event === "stage") streaming.set(k, data.stage);
			else if (event === "message") summaries.set(k, summaries.get(k) + data.delta);
			else if (event === "done") summaries.set(k, data.summary), streaming.delete(k);
			paint(kind, item);
		});
		if (streaming.has(k)) throw new Error("The summary stopped before the end; try again");
	} catch (e) {
		summaries.delete(k);
		toast(e.message);
	} finally {
		streaming.delete(k);
		render();
	}
}

// -- the triage list (SPEC 13) ------------------------------------------------------
// One line per item. One row is selected; when `expanded`, the selected row shows its
// details and actions under it. Everything below works the same from keys and taps.

// what each key does to the selected item; returns a reason when it does not apply
const ACTIONS = {
	open: (x, k) => (k === "pr" ? void (location.hash = `#pr/${x.repo}/${x.number}`) : void window.open(x.url, "_blank", "noopener")), // SPEC 16
	github: (x) => { window.open(x.url, "_blank", "noopener"); },
	approve: (x, k) => (k !== "pr" ? "Issues cannot be approved" : x.author.toLowerCase() === data.login.toLowerCase() ? "You cannot approve your own PR" : doAction(x, "approve")),
	merge: (x, k) => (k !== "pr" ? "Issues cannot be merged" : confirm(`Merge ${keyOf(x)}?\n\n${x.title}`) ? doAction(x, "merge", { confirm: true }) : null),
	rerun: (x, k) => (k !== "pr" || x.checks !== "failure" ? "No failed checks to re-run" : doAction(x, "rerun")),
	comment: async (x, k) => {
		if (k !== "pr") return "Comment on issues on GitHub";
		const b = prompt(`Comment on ${keyOf(x)}`);
		if (b && b.trim()) await doAction(x, "comment", { body: b });
	},
	summarize: (x, k) => (data[k]?.summarize ? summarize(k, x) : "Summaries are not set up"),
	files: (x, k) => (k !== "pr" ? "Files are for pull requests" : void (location.hash = `#pr/${x.repo}/${x.number}/files`)),
	hide: (x, k, hidden) => {
		// hiding the selected row hands the selection to the next live row (or the one above)
		const i = shown.findIndex((r) => r.key === view.sel);
		if (!hidden && i >= 0 && shown[i].item === x) {
			const next = shown.slice(i + 1).find((r) => !r.hidden) ?? shown.slice(0, i).reverse().find((r) => !r.hidden);
			if (next) view.sel = next.key;
		}
		return setHidden(k, x, !hidden);
	},
};
const KEYS = { f: "files", Enter: "open", o: "open", g: "github", a: "approve", m: "merge", r: "rerun", c: "comment", s: "summarize", h: "hide" };

async function act(name, entry = selected()) {
	if (!entry) return;
	const why = await ACTIONS[name](entry.item, entry.kind, entry.hidden);
	if (typeof why === "string") toast(why);
}

// rows currently on screen, in order (rows in a closed fold do not count)
let shown = [];
const selected = () => shown.find((r) => r.key === view.sel);

function select(key, { expand, scroll = true } = {}) {
	view.sel = key;
	if (expand !== undefined) view.expanded = expand;
	render();
	if (scroll) main.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
}

function move(by) {
	if (!shown.length) return;
	const i = shown.findIndex((r) => r.key === view.sel);
	const next = i < 0 ? 0 : Math.min(shown.length - 1, Math.max(0, i + by));
	select(shown[next].key);
}

function cell(cls, text, label) {
	return el("span", { class: cls, role: label ? "img" : null, "aria-label": label, title: label }, text);
}

function prLine(pr) {
	const [cg, cl] = CHECKS[pr.checks] || CHECKS.none;
	const rv = REVIEW[pr.reviewDecision];
	return [
		el("span", { class: "flags" },
			pr.draft ? el("span", { class: "flag" }, "draft") : null,
			pr.mergeable === "CONFLICTING" ? el("span", { class: "flag bad" }, "conflicts") : null),
		cell(`ci ci-${pr.checks}`, cg, cl),
		rv ? cell(`rv rv-${pr.reviewDecision.toLowerCase()}`, rv[0], rv[1]) : cell("rv", "", null),
	];
}

function issueLine(i) {
	return [
		el("span", { class: "flags" }, i.labels.slice(0, 2).map((l) => el("span", { class: "flag label" }, l))),
		cell("ci", i.comments ? `${i.comments}` : "", i.comments ? `${i.comments} comment${i.comments > 1 ? "s" : ""}` : null),
		cell("rv", "", null),
	];
}

function detail(entry) {
	const { item: x, kind, hidden } = entry;
	const facts = kind === "pr"
		? [CHECKS[x.checks]?.[1], REVIEW[x.reviewDecision]?.[1], x.draft ? "draft" : null, x.mergeable === "CONFLICTING" ? "merge conflicts" : null, `updated ${age(x.updatedAt)} ago`]
		: [x.assignees.length ? `assigned to ${x.assignees.join(", ")}` : "unassigned", x.comments ? `${x.comments} comments` : null, ...x.labels, `updated ${age(x.updatedAt)} ago`];
	const btn = (key, label, name, cls = "") => el("button", { class: cls, onclick: busy(() => act(name, entry)) }, el("kbd", {}, key), label);
	return el("div", { class: "detail" },
		el("div", { class: "facts" }, facts.filter(Boolean).join(" · ")),
		summaryBox(kind, x),
		el("div", { class: "actions" },
			// SPEC 13: Approve, Merge, Comment and Open are keys only (fewer buttons)
			kind === "pr" ? btn("f", "Files", "files") : null,
			kind === "pr" && x.checks === "failure" ? btn("r", "Re-run failed", "rerun") : null,
			data[kind]?.summarize ? btn("s", "Summarize", "summarize") : null,
			btn("h", hidden ? "Unhide" : "Hide", "hide")));
}

function row(entry) {
	const { item: x, kind, tone } = entry;
	const sel = entry.key === view.sel;
	const li = el("li", {
		class: ["row", tone && `tone-${tone}`, stale(x) && "stale", sel && "sel", sel && view.expanded && "open"].filter(Boolean).join(" "),
		role: "option", "aria-selected": String(sel), "data-key": entry.key,
	},
	el("div", { class: "line" },
		el("span", { class: "mark", "aria-hidden": "true" }),
		el("span", { class: "ref" }, x.repo.split("/")[1], el("span", { class: "num" }, `#${x.number}`)),
		kind === "pr" ? el("a", { class: "title", href: `#pr/${x.repo}/${x.number}`, tabindex: "-1" }, x.title) // SPEC 16: the PR page
			: el("a", { class: "title", href: x.url, target: "_blank", rel: "noopener", tabindex: "-1" }, x.title),
		...(kind === "pr" ? prLine(x) : issueLine(x)),
		el("span", { class: "age", title: `updated ${new Date(x.updatedAt).toLocaleString()}` }, age(x.updatedAt)),
		el("span", { class: "who" }, x.author)),
	sel && view.expanded ? detail(entry) : null);
	li.addEventListener("click", (e) => {
		if (e.target.closest(".detail") || e.target.closest("a.title") && sel) return;
		e.preventDefault(); // the title link opens on the second tap, once the row is selected
		select(entry.key, { expand: !(sel && view.expanded), scroll: false });
	});
	return li;
}

function list(entries, label) {
	shown.push(...entries);
	return el("ul", { class: "list", role: "listbox", "aria-label": label }, entries.map(row));
}

function fold(id, title, entries) {
	if (!entries.length) return null;
	const d = el("details", { class: "fold", open: view.folds[id] || entries.some((e) => e.key === view.sel) },
		el("summary", {}, title, el("span", { class: "n" }, entries.length)));
	d.addEventListener("toggle", () => {
		if (d.open === Boolean(view.folds[id])) return; // also fires for the initial open state
		view.folds = { ...view.folds, [id]: d.open };
		render();
	});
	if (d.open) d.append(list(entries, title));
	return d;
}

function render() {
	// keep the focus and the caret in a box being typed in, on every page
	const focused = document.activeElement?.dataset?.draft;
	const caret = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
	renderPage();
	if (document.activeElement?.dataset?.draft !== focused) refocus(focused, caret);
	renderTray();
}

function renderPage() {
	if (onCompare()) return renderCompare();
	if (onFiles()) { // SPEC 16: the old Files address is the PR page's Files changed tab
		const t = filesTarget();
		history.replaceState(null, "", t ? `#pr/${t.repo}/${t.number}/files` : location.pathname + location.search);
		return renderPage();
	}
	document.body.classList.remove("guiding");
	if (onPr()) return renderPr();
	document.body.classList.remove("files");
	if (onSettings()) {
		if (devices === null) loadDevices();
		return renderSettings();
	}
	document.body.classList.remove("settings");
	const kind = view.kind;
	const kd = data[kind];
	if (!kd) return;
	for (const b of $("#kind").children) b.classList.toggle("on", b.dataset.k === kind);

	// repo filter: every repo with something in this view (live, old or hidden)
	const all = kind === "pr" ? [...kd.sections.flatMap((s) => s.prs), ...kd.old, ...kd.hidden] : [...kd.items, ...kd.old, ...kd.hidden];
	const repos = [...new Set(all.map((x) => x.repo))].sort((a, b) => a.split("/")[1].localeCompare(b.split("/")[1], undefined, { sensitivity: "base" }));
	if (view.repo && !repos.includes(view.repo)) view.repo = "";
	$("#repo").replaceChildren(el("option", { value: "" }, "All repos"), ...repos.map((r) => el("option", { value: r, selected: r === view.repo }, r.split("/")[1])));

	const wrap = (xs, extra = {}) => byRepo(xs).map((item) => ({ item, kind, key: `${kind}:${keyOf(item)}`, ...extra }));
	let live;
	const tabs = $("#tabs");
	if (kind === "pr") {
		const per = Object.fromEntries(kd.sections.map((s) => [s.id, wrap(s.prs, { tone: TONE[s.id] })]));
		per.all = kd.sections.flatMap((s) => per[s.id]).sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt));
		if (!per[view.tab]) view.tab = "needs_you";
		tabs.hidden = false;
		tabs.replaceChildren(...PR_TABS.map(([id, name], i) =>
			el("button", { class: id === view.tab ? "on" : "", "aria-keyshortcuts": String(i + 1), onclick: () => { view.tab = id; remember(); render(); } },
				name, el("span", { class: "n" }, per[id].length))));
		live = per[view.tab];
	} else {
		tabs.hidden = true;
		live = wrap(kd.items);
	}

	const prev = shown.findIndex((r) => r.key === view.sel);
	shown = [];
	main.dataset.view = kind === "pr" ? view.tab : "issues"; // lets the skin mark "needs you" rows only where that adds something
	main.replaceChildren();
	main.append(live.length ? list(live, kind === "pr" ? "Pull requests" : "Issues") : el("p", { class: "empty" }, kind === "pr" ? "Nothing here. Nice." : "No open issues"));
	main.append(fold("old", "Old: no activity for 30+ days", wrap(kd.old)) || "", fold("hidden", "Hidden", wrap(kd.hidden, { hidden: true })) || "");
	// keep a selection: the same item, or the one now in its place (after merge/hide)
	if (shown.length && !shown.some((r) => r.key === view.sel)) {
		view.sel = shown[Math.min(Math.max(prev, 0), shown.length - 1)].key;
		return render();
	}
}

// -- keyboard (SPEC 13) -------------------------------------------------------------
const help = () => $("#help");
document.addEventListener("keydown", (e) => {
	if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
	const t = e.target;
	if (t.closest?.("input, textarea, select, [contenteditable]")) {
		if (e.key === "Escape") t.blur();
		return;
	}
	if (onPr()) { // SPEC 16
		if (e.key === "Escape") prEscape();
		else if (prTarget().tab === "guide" && guideKey(e.key)) e.preventDefault(); // SPEC 19
		return;
	}
	if (onCompare()) { // SPEC 15
		if (e.key === "Escape") goBack();
		return;
	}
	if (onSettings()) { // SPEC 14: list keys do nothing here
		if (e.key === "Escape") goBack();
		return;
	}
	if (help().open) {
		if (e.key === "?" || e.key === "Escape") { e.preventDefault(); help().close(); }
		return;
	}
	const k = e.key;
	if (k === "?") return e.preventDefault(), help().showModal();
	if (k === "j" || k === "ArrowDown") return e.preventDefault(), move(1);
	if (k === "k" || k === "ArrowUp") return e.preventDefault(), move(-1);
	if (k === "x" || k === " ") return e.preventDefault(), view.sel && select(view.sel, { expand: !view.expanded });
	if (k === "Escape") return view.expanded && select(view.sel, { expand: false });
	if (k === "/") return e.preventDefault(), $("#repo").focus();
	if (k === "p" || k === "i") return switchKind(k === "p" ? "pr" : "issue");
	if (view.kind === "pr" && /^[1-4]$/.test(k)) {
		view.tab = PR_TABS[Number(k) - 1][0];
		remember();
		return render();
	}
	if (KEYS[k] && (k !== "Enter" || t === document.body || t.closest?.(".row"))) {
		e.preventDefault();
		act(KEYS[k]);
	}
});

function switchKind(k) {
	if (k === view.kind) return;
	view.kind = k;
	remember();
	render();
}

async function load() {
	const [pr, issue] = await Promise.all([api("/api/inbox"), api("/api/issues")]);
	if (pr.status === 409 && pr.data.link) {
		$("#tabs").hidden = true;
		main.replaceChildren(el("div", { class: "notice" },
			el("p", {}, "Connect your GitHub account once so the inbox can show the PRs and issues you can see, and so actions run as you."),
			el("a", { class: "btn primary", href: pr.data.link }, "Connect GitHub")));
		return;
	}
	if (pr.status !== 200) {
		main.replaceChildren(el("p", { class: "empty" }, pr.data.error || `Could not load (${pr.status})`));
		return;
	}
	if (VERSION && pr.data.version && pr.data.version !== VERSION) {
		location.reload(); // a newer version was deployed while this page was open
		return;
	}
	$("#tabs").hidden = view.kind !== "pr";
	data = { pr: pr.data, issue: issue.status === 200 ? issue.data : { items: [], old: [], hidden: [] }, login: pr.data.login };
	const seg = $("#kind").children;
	seg[0].replaceChildren("PRs", el("span", { class: "n" }, pr.data.sections.reduce((n, s) => n + s.prs.length, 0)));
	seg[1].replaceChildren("Issues", el("span", { class: "n" }, data.issue.items.length));
	render();
	refreshPush();
	if (onSettings()) loadDevices();
	markSeen();
}

// SPEC 7: opening Nudgebox clears the unread count, on this icon and on the server
function markSeen() {
	navigator.clearAppBadge?.().catch(() => {});
	if (desktop) desktop.invoke("set_badge", { count: 0 }).catch(() => {});
	api("/api/push/seen", {}).catch(() => {});
}

async function unlink() {
	if (!confirm("Disconnect GitHub? The stored token is deleted.")) return;
	await api("/api/unlink", {});
	history.replaceState(null, "", location.pathname + location.search);
	document.body.classList.remove("settings");
	load();
}

$("#kind").addEventListener("click", (e) => {
	const k = e.target.closest("button")?.dataset.k;
	if (k) switchKind(k);
});
$("#repo").addEventListener("change", (e) => {
	view.repo = e.target.value;
	remember();
	render();
});

// -- push on this device (SPEC 7, 14) ----------------------------------------------
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function b64url(s) {
	const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// this device: state "on" | "off" | "blocked" | "unavailable", with the reason shown in Settings
let push = { state: "off", reason: "", sub: null, reg: null };
let swReg = null;

// SPEC 18: inside the Nudgebox desktop app (Tauri), notifications come over a live stream
// from the server and are shown by the app itself; web push is not used there.
const desktop = window.__TAURI__?.core?.invoke ? { invoke: window.__TAURI__.core.invoke, client: null } : null;

function openDesktopStream() {
	if (window.nudgeboxStream && window.nudgeboxStream.readyState !== EventSource.CLOSED) return;
	const es = (window.nudgeboxStream = new EventSource("/api/events"));
	es.addEventListener("hello", (e) => (desktop.client = JSON.parse(e.data).client));
	es.addEventListener("notify", async (e) => {
		const n = JSON.parse(e.data);
		let shown = true;
		try {
			await desktop.invoke("notify", { title: n.title, body: n.body, url: n.url ?? "/" });
		} catch (err) {
			shown = String(err?.message ?? err);
		}
		if (typeof n.badge === "number") desktop.invoke("set_badge", { count: n.badge }).catch(() => {});
		if (n.test) {
			const report = { shown: shown === true, error: shown === true ? undefined : shown };
			// the stream can bring the test before Send a test hears back from the server
			const wait = testWaits.get(n.test);
			if (wait) wait(report);
			else earlyTests.set(n.test, report);
		}
	});
	// a closed stream (the lab sign-in expired, or the server restarted): reload, which signs in again
	es.addEventListener("error", () => es.readyState === EventSource.CLOSED && setTimeout(() => location.reload(), 10_000));
}

async function refreshPush() {
	if (desktop) {
		push = { state: "on", desktop: true, sub: null, reg: null, reason: "" };
		openDesktopStream();
	} else if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
		push = { state: "unavailable", sub: null, reg: null, reason: isIOS && !standalone
			? "On iPhone, notifications only work in the Nudgebox app on your Home Screen. In Safari, tap Share, then Add to Home Screen, then open Nudgebox from the Home Screen."
			: "This browser can't receive notifications. Use Safari or Chrome." };
	} else {
		try {
			swReg ??= await navigator.serviceWorker.register("/sw.js");
			const sub = await swReg.pushManager.getSubscription();
			if (sub) push = { state: "on", sub, reg: swReg, reason: "" };
			else if (window.Notification?.permission === "denied") push = { state: "blocked", sub: null, reg: swReg, reason: isIOS
				? "Notifications are blocked for Nudgebox. Allow them in the iPhone's Settings → Notifications → Nudgebox."
				: `Notifications are blocked for this site. Allow ${location.host} in your browser's site settings, and the browser in System Settings → Notifications.` };
			else push = { state: "off", sub: null, reg: swReg, reason: "" };
		} catch (e) {
			push = { state: "unavailable", sub: null, reg: null, reason: `Notifications could not start here (${e.message}).` };
		}
	}
	const bell = $("#bell");
	bell.dataset.state = push.state;
	bell.setAttribute("aria-label", { on: "Notifications on", off: "Notifications off", blocked: "Notifications blocked", unavailable: "Notifications unavailable here" }[push.state]);
	bell.title = bell.getAttribute("aria-label");
	if (onSettings()) renderSettings();
}

async function turnOn() {
	if ((await Notification.requestPermission()) !== "granted") {
		await refreshPush();
		return toast("Notifications were not allowed");
	}
	try {
		const { data: k } = await api("/api/push/key");
		const s = await push.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(k.publicKey) });
		const { status } = await api("/api/push/subscribe", s.toJSON());
		toast(status === 201 ? "Notifications are on for this device" : `Could not turn on notifications (${status})`);
	} catch (e) {
		toast(`Could not turn on notifications: ${e.message}`);
	}
	await refreshPush();
	loadDevices();
}

async function turnOff() {
	if (!push.sub || !confirm("Turn off notifications on this device?")) return;
	await api("/api/push/unsubscribe", { endpoint: push.sub.endpoint });
	await push.sub.unsubscribe();
	toast("Notifications are off for this device");
	await refreshPush();
	loadDevices();
}

// SPEC 14: Send a test says which part failed, from the service worker's report
const PUSH_CHECK_MS = window.pushCheckMs ?? 15000;
const testWaits = new Map(); // test id -> resolve(report)
const earlyTests = new Map(); // SPEC 18: test id -> report that came before its wait
navigator.serviceWorker?.addEventListener?.("message", (e) => {
	if (e.data?.type === "push-received") testWaits.get(e.data.test)?.(e.data);
});
let pushCheck = "";
function setCheck(text) {
	pushCheck = text;
	const p = $("#push-check");
	if (p) p.textContent = text;
}

function browserName() {
	const ua = navigator.userAgent;
	return /Edg\//.test(ua) ? "Microsoft Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Google Chrome" : /Safari\//.test(ua) ? "Safari" : "your browser";
}

async function sendTest() {
	setCheck("Sending a test…");
	const { status, data: d } = push.desktop
		? await api("/api/events/test", { client: desktop.client })
		: await api("/api/push/test", { endpoint: push.sub.endpoint });
	if (status !== 200) return setCheck(d.error || `Could not send the test (${status}).`);
	setCheck(push.desktop ? "Test sent. Waiting for this app to receive it…" : "Test sent to the push service. Waiting for this device to receive it…");
	const got = await new Promise((resolve) => {
		if (earlyTests.has(d.id)) return resolve(earlyTests.get(d.id));
		testWaits.set(d.id, resolve);
		setTimeout(() => resolve(null), PUSH_CHECK_MS);
	});
	testWaits.delete(d.id);
	const secs = Math.round(PUSH_CHECK_MS / 1000);
	if (push.desktop) return setCheck(!got
		? `The app did not receive the test within ${secs} seconds. Check the internet connection, or quit Nudgebox and open it again.`
		: got.shown ? "This app received the test and asked the system to show it. If no notification appeared, open System Settings → Notifications → Nudgebox (on Linux, your desktop's notification settings), allow notifications, and check Focus or Do Not Disturb."
		: `This app received the test but could not show it: ${got.error}.`);
	if (!got) setCheck(`This device did not receive the test within ${secs} seconds. The push service accepted it, so the problem is between the push service and this browser: keep ${browserName()} open and up to date, or turn notifications off and on again here.`);
	else if (got.shown) setCheck(isIOS
		? "This device received the test and asked iOS to show it. If no notification appeared, iOS hides it: check Settings → Notifications → Nudgebox, and Focus."
		: `This device received the test and asked the system to show it. If no notification appeared, your computer hides it: on a Mac, open System Settings → Notifications → ${browserName()}, allow notifications with the Banners or Alerts style, and check Focus.`);
	else setCheck(`This device received the test but could not show it: ${got.error}.`);
}

// -- settings (SPEC 14) -------------------------------------------------------------
const onSettings = () => location.hash === "#settings";
let devices = null; // your devices with notifications on, from the server

async function loadDevices() {
	const { status, data: d } = await api("/api/push/subscriptions");
	devices = status === 200 ? d : [];
	if (onSettings()) renderSettings();
}

const deviceKind = (endpoint) => {
	const h = new URL(endpoint).host;
	if (h.endsWith("push.apple.com")) return "Apple (iPhone, iPad or Mac Safari)";
	if (h.endsWith("googleapis.com")) return "Chrome";
	if (h.endsWith("mozilla.com")) return "Firefox";
	if (h.endsWith("windows.com")) return "Edge";
	return h;
};

function theme() {
	try { return localStorage.getItem("ghd-theme") || "system"; } catch { return "system"; }
}
function setTheme(t) {
	try { t === "system" ? localStorage.removeItem("ghd-theme") : localStorage.setItem("ghd-theme", t); } catch {}
	if (t === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = t;
	renderSettings();
}

function goBack() {
	history.replaceState(null, "", location.pathname + location.search);
	render();
}

function section(id, title, ...kids) {
	return el("section", { id, class: "set" }, el("h3", {}, title), ...kids);
}

// -- AI settings (SPEC 20): admin only ----------------------------------------------------
let aiForm = null; // the form as typed; the key only ever comes from typing
let aiModelList = [];
let aiResult = "";
const AI_PROVIDERS = [["off", "Off"], ["openai", "OpenAI"], ["anthropic", "Anthropic"], ["compatible", "OpenAI-compatible"]];

async function loadAi() {
	const { status, data: d } = await api("/api/ai");
	if (status !== 200) return;
	aiForm = { provider: d.provider ?? "off", baseUrl: d.baseUrl ?? "", model: d.model ?? "", deepModel: d.deepModel ?? "", noThinking: Boolean(d.noThinking), keySet: d.keySet, from: d.from, apiKey: "" };
	if (onSettings()) renderSettings();
	if (aiForm.provider !== "off") loadAiModels();
}

const aiBody = () => ({ provider: aiForm.provider, baseUrl: aiForm.baseUrl, apiKey: aiForm.apiKey, model: aiForm.model, deepModel: aiForm.deepModel, noThinking: aiForm.noThinking });

async function loadAiModels() {
	if (!aiForm || aiForm.provider === "off" || (aiForm.provider === "compatible" && !aiForm.baseUrl)) return;
	const n = (loadAiModels.n = (loadAiModels.n ?? 0) + 1);
	const { data: d } = await api("/api/ai/models", aiBody());
	if (n !== loadAiModels.n) return; // a newer request was sent meanwhile
	aiModelList = d.models ?? [];
	$("#ai-models")?.replaceChildren(...aiModelList.map((m) => el("option", { value: m })));
	const note = $("#ai-models-note");
	if (note) note.textContent = d.error ? `Could not list the models: ${d.error}` : aiModelList.length ? `${aiModelList.length} models from the provider; you can also type a name.` : "";
}

function setAiResult(text, cls = "") {
	aiResult = text;
	const r = $("#ai-result");
	if (r) { r.textContent = text; r.className = `hint ${cls}`; }
}

async function testAi() {
	setAiResult("Asking…");
	const { status, data: d } = await api("/api/ai/test", aiBody());
	if (status !== 200) return setAiResult(`✗ ${d.error || status}`, "bad");
	setAiResult(d.ok ? `✓ Answered in ${(d.ms / 1000).toFixed(1)} s` : `✗ ${d.error}`, d.ok ? "good" : "bad");
}

async function saveAi() {
	const { status, data: d } = await api("/api/ai", aiBody());
	if (status !== 200) return setAiResult(`✗ ${d.error || status}`, "bad");
	toast(d.provider === "off" ? "AI is off" : "AI settings saved");
	aiForm = { ...aiForm, ...d, baseUrl: d.baseUrl ?? "", deepModel: d.deepModel ?? "", apiKey: "" };
	setAiResult("");
	load(); // the AI buttons follow the new setting
}

function aiShow() {
	const p = aiForm.provider;
	const show = (sel, on) => { const n = $(sel); if (n) n.hidden = !on; };
	show("#ai-address-row", p === "compatible");
	show("#ai-qwen-row", p === "compatible");
	show("#ai-key-row", p !== "off");
	show("#ai-model-rows", p !== "off");
	const key = $("#ai-key");
	if (key) key.placeholder = aiForm.keySet ? "Saved. Leave empty to keep it." : p === "compatible" ? "Optional (Ollama needs none)" : "Paste your API key";
}

function aiSection() {
	if (!aiForm) return section("ai", "AI", el("p", { class: "hint" }, "Loading…"));
	const f = aiForm;
	const field = (id, label, attrs, key) => el("label", { class: "ai-field", for: id }, el("span", {}, label),
		el("input", { id, value: f[key] ?? "", autocomplete: "off", spellcheck: "false", ...attrs }));
	const s = section("ai", "AI",
		el("p", { class: "hint" }, "The model behind Summarize, Explain and Guided review, for everyone. Only admins see this. ",
			f.from === "server" ? "Now using the server's own setting (config.yaml); saving here replaces it." : ""),
		el("div", { class: "seg ai-provider", role: "radiogroup", "aria-label": "Provider" },
			AI_PROVIDERS.map(([v, label]) => el("label", { class: f.provider === v ? "on" : "" },
				el("input", { type: "radio", name: "ai-provider", value: v, checked: f.provider === v }), label))),
		el("div", { id: "ai-address-row" }, field("ai-address", "Address", { placeholder: "http://localhost:11434/v1", inputmode: "url" }, "baseUrl")),
		el("div", { id: "ai-key-row" }, field("ai-key", "API key", { type: "password" }, "apiKey")),
		el("label", { id: "ai-qwen-row", class: "ai-check" }, el("input", { type: "checkbox", id: "ai-qwen", checked: f.noThinking }), "Qwen: turn thinking off (vLLM, SGLang)"),
		el("div", { id: "ai-model-rows" },
			field("ai-model", "Model for summaries and guided review", { list: "ai-models" }, "model"),
			field("ai-deep-model", "Model for Deep review (on request)", { list: "ai-models", placeholder: "Same as above" }, "deepModel"),
			el("datalist", { id: "ai-models" }, aiModelList.map((m) => el("option", { value: m }))),
			el("p", { id: "ai-models-note", class: "hint" })),
		el("div", { class: "actions" },
			el("button", { onclick: busy(testAi), id: "ai-test" }, "Test"),
			el("button", { class: "primary", onclick: busy(saveAi) }, "Save")),
		el("p", { id: "ai-result", class: "hint", role: "status" }, aiResult));
	s.addEventListener("change", (e) => {
		const t = e.target;
		if (t.name === "ai-provider") {
			aiForm.provider = t.value;
			s.querySelectorAll(".ai-provider label").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
			aiShow();
			loadAiModels();
		} else if (t.id === "ai-qwen") aiForm.noThinking = t.checked;
		else if (t.id === "ai-key" || t.id === "ai-address") loadAiModels();
	});
	s.addEventListener("input", (e) => {
		const k = { "ai-address": "baseUrl", "ai-key": "apiKey", "ai-model": "model", "ai-deep-model": "deepModel" }[e.target.id];
		if (k) aiForm[k] = e.target.value;
	});
	queueMicrotask(aiShow);
	return s;
}

function renderSettings() {
	document.body.classList.add("settings");
	$("#tabs").hidden = true;
	const t = theme();
	const p = push;
	const stateText = p.desktop ? "On in the Nudgebox desktop app. Notifications come while the app runs; closing the window keeps it in the menu bar." : { on: "On for this device.", off: "Off on this device.", blocked: p.reason, unavailable: `Not possible here. ${p.reason}` }[p.state];
	const since = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	main.replaceChildren(el("div", { id: "settings-page" },
		el("div", { class: "set-head" }, el("button", { id: "back", class: "quiet", onclick: goBack }, "← Back"), el("h2", {}, "Settings")),
		section("appearance", "Appearance",
			el("div", { class: "seg theme", role: "group", "aria-label": "Theme" },
				["system", "dark", "light"].map((c) => el("button", { "data-theme-choice": c, "aria-pressed": String(t === c), class: t === c ? "on" : "", onclick: () => setTheme(c) },
					c[0].toUpperCase() + c.slice(1)))),
			el("p", { class: "hint" }, "System follows this device's light or dark setting. Kept on this device only.")),
		section("notifications", "Notifications on this device",
			el("p", { id: "push-state", class: `state ${p.state}` }, el("span", { class: "dot", "aria-hidden": "true" }), stateText),
			el("div", { class: "actions" },
				p.state === "off" ? el("button", { class: "primary", onclick: busy(turnOn) }, "Turn on notifications") : null,
				p.state === "on" ? el("button", { onclick: busy(sendTest) }, "Send a test") : null,
				p.state === "on" && !p.desktop ? el("button", { onclick: busy(turnOff) }, "Turn off") : null),
			p.state === "on" ? el("p", { id: "push-check", class: "hint", role: "status" }, pushCheck) : null),
		section("devices", "Your devices with notifications",
			devices === null ? el("p", { class: "hint" }, "Loading…")
				: !devices.length ? el("p", { class: "hint" }, "None yet. Turn notifications on above, on each device you want them on.")
				: el("ul", { class: "devices" }, devices.map((d) => {
					const here = d.endpoint === p.sub?.endpoint;
					return el("li", { class: "device" },
						el("span", { class: "kind" }, deviceKind(d.endpoint)), el("span", { class: "since" }, `since ${since(d.created)}`),
						here ? el("span", { class: "here" }, "This device")
							: el("button", { class: "quiet", onclick: busy(async () => { await api("/api/push/unsubscribe", { endpoint: d.endpoint }); toast("Removed"); loadDevices(); }) }, "Remove"));
				}))),
		section("triggers", "What notifies you",
			el("ul", { class: "plain" },
				el("li", {}, "A review is requested from you (or a team you are in)"),
				el("li", {}, "CI finished on your PR, passed or failed (once per commit)"),
				el("li", {}, `At 9 AM: your PRs and reviews with no activity for ${data.pr?.staleDays ?? 3}+ days`),
				el("li", {}, "An issue is assigned to you, you are @mentioned, or someone comments on your issue")),
			el("p", { class: "hint" }, "Hidden and old items never notify. The number on the app icon counts notifications since you last opened Nudgebox.")),
		section("github", "GitHub account",
			el("p", {}, "Connected as ", el("b", {}, data.login || "…"), " on GitHub, for lab login ", el("b", {}, data.pr?.user || "…"), ". Actions run as this GitHub account."),
			el("div", { class: "actions" }, el("button", { class: "danger", onclick: unlink }, "Disconnect GitHub"))),
		data.pr?.admin ? aiSection() : null));
	if (data.pr?.admin && !aiForm && !loadAi.started) {
		loadAi.started = true;
		loadAi();
	}
	if (location.hash === "#settings" && renderSettings.scrollTo) {
		$(`#${renderSettings.scrollTo}`)?.scrollIntoView({ block: "start" });
		renderSettings.scrollTo = null;
	}
}

function openSettings(part) {
	renderSettings.scrollTo = part ?? null;
	if (!onSettings()) location.hash = "#settings"; // hashchange renders it
	else renderSettings();
}

// -- files and diffs (SPEC 15) --------------------------------------------------------
const onFiles = () => location.hash.startsWith("#files/");
let files = fileSet(null); // the open PR's Files changed
const STATUS = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" };
const NOTE = {
	whitespace_only: "Only whitespace changed.", comment_only: "Only comments changed.", refactor_moved_only: "Only moved code: nothing else changed.",
	new_file: "New file.", deleted_file: "Deleted file.", no_changes: "No changes.",
};

function filesTarget() {
	const m = location.hash.match(/^#files\/([^/]+\/[^/]+)\/(\d+)$/);
	return m && { repo: decodeURIComponent(m[1]), number: Number(m[2]) };
}

// a list of changed files (a PR's or a commit's): `data` from the server, which are open,
// their diffs and Markdown modes
function fileSet(key) {
	return { key, data: null, error: null, open: new Set(), diffs: new Map(), mdMode: new Map() };
}

async function loadFileSet(st, url) {
	const { status, data: d } = await api(url);
	if (status === 200) st.data = d;
	else st.error = d.error || `Could not load the files (${status})`;
	render();
}

async function loadDiff(st, repo, f) {
	const d = st.data;
	const before = f.status === "added" ? null : { repo, ref: d.base, path: f.previous ?? f.path };
	const after = f.status === "removed" ? null : { repo, ref: d.head, path: f.path };
	const { status, data: r } = await api("/api/diff", { before, after });
	st.diffs.set(f.path, status === 200 ? r : { error: r.error || `Could not diff (${status})` });
	render();
}

const inRanges = (ranges, n) => (ranges ?? []).some(([a, b]) => n >= a && n <= b);

// one side of a diff: changed lines with 3 lines of context, the rest folded. `review`
// (SPEC 16): + on lines GitHub takes a comment on, threads under their line, the open form
// a file's lines and, per line, the parts omnidiff marks (op, columns, a title)
function markLines(side, text, hunks) {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	const marks = lines.map(() => []);
	for (const h of hunks) {
		for (let row = h.from.row; row <= Math.min(h.to.row, lines.length - 1); row++) {
			const start = row === h.from.row ? h.from.col : 0;
			const end = row === h.to.row ? h.to.col : lines[row].length;
			if (row === h.to.row && row !== h.from.row && end === 0) continue; // a range that ends at the start of a row
			const title = h.op === "move" && h.target
				? side === "before" ? `moved to line ${h.target.from.row + 1}` : `moved from line ${h.target.from.row + 1}`
				: { insert: "added", delete: "removed", update: "changed" }[h.op];
			marks[row].push({ start, end: Math.max(end, start), op: h.op, title });
		}
	}
	return { lines, marks };
}

// one line's code with omnidiff's marks as spans
function codeParts(line, marks) {
	const parts = [];
	let at = 0;
	for (const m of [...marks].sort((a, b) => a.start - b.start)) {
		if (m.start < at) continue; // overlapping ranges: keep the first
		if (m.start > at) parts.push(line.slice(at, m.start));
		parts.push(el("span", { class: `m-${m.op}`, title: m.title }, line.slice(m.start, m.end)));
		at = m.end;
	}
	if (at < line.length) parts.push(line.slice(at));
	return parts;
}

// a line number; where GitHub takes a comment, tapping it opens the comment box (SPEC 16)
function lineNo(n, sideKey, review) {
	const can = review && inRanges(review.commentable?.[sideKey === "LEFT" ? "left" : "right"], n);
	if (!can) return el("span", { class: "ln" }, n);
	return el("span", { class: "ln can-comment", role: "button", tabindex: "-1", title: "Comment on this line",
		onclick: (e) => { e.stopPropagation(); review.onAdd(sideKey, n); } }, n);
}

function pane(side, ref, text, hunks, label, review) {
	const { lines, marks } = markLines(side, text, hunks);
	const show = lines.map(() => false);
	marks.forEach((m, row) => {
		if (m.length) for (let r = Math.max(0, row - 3); r <= Math.min(lines.length - 1, row + 3); r++) show[r] = true;
	});
	const sideKey = side === "before" ? "LEFT" : "RIGHT";
	const threadsAt = new Map();
	for (const th of review?.threads ?? []) {
		if (th.side !== sideKey || !th.line || th.line > lines.length) continue;
		threadsAt.set(th.line, [...(threadsAt.get(th.line) ?? []), th]);
		show[th.line - 1] = true;
	}
	const form = review?.form?.subject === "line" && review.form.path === review.path && review.form.side === sideKey ? review.form : null;
	if (form && form.line <= lines.length) show[form.line - 1] = true;
	const out = [];
	let hidden = 0;
	const fold = () => {
		if (hidden) out.push(el("div", { class: "fold" }, `${hidden} unchanged line${hidden > 1 ? "s" : ""}`));
		hidden = 0;
	};
	lines.forEach((line, row) => {
		if (!show[row]) return void hidden++;
		fold();
		const parts = codeParts(line, marks[row]);
		const n = row + 1;
		const add = review && inRanges(review.commentable?.[sideKey === "LEFT" ? "left" : "right"], n)
			? el("button", { class: "add-comment", "aria-label": `Comment on line ${n}`, title: "Comment on this line",
				onclick: (e) => { e.stopPropagation(); review.onAdd(sideKey, n); } }, "+") : null;
		out.push(el("div", { class: `code-line${marks[row].length ? " changed" : ""}` }, add, lineNo(n, sideKey, review), el("span", { class: "code" }, parts)));
		for (const th of threadsAt.get(n) ?? []) out.push(threadView(th, "files"));
		if (form && form.line === n) out.push(commentForm(form));
	});
	fold();
	return el("section", { class: `pane ${side}` },
		el("h4", {}, label ?? (side === "before" ? "Before" : "After"), el("span", { class: "sha" }, ref.slice(0, 7))),
		el("div", { class: "lines" }, out));
}

// SPEC 15: Markdown files render; the libraries load only when one is opened
let mdLib = null;
function loadMd() {
	mdLib ??= Promise.all([import("/vendor/marked-18.1.3.esm.js"), import("/vendor/purify-3.4.17.es.mjs")]).then(([m, p]) => {
		const purify = p.default;
		purify.addHook("afterSanitizeAttributes", (n) => {
			if (n.tagName === "A") n.setAttribute("target", "_blank"), n.setAttribute("rel", "noopener noreferrer");
		});
		mdLib.ready = { marked: m.marked, purify };
		render();
	});
	return mdLib.ready;
}
const isMd = (path) => /\.(md|markdown)$/i.test(path);

// one side, rendered: top-level blocks, each marked if a change touches its lines
function mdPane(side, ref, text, hunks, lib, label) {
	const tokens = lib.marked.lexer(text);
	const blocks = [];
	let row = 0;
	const lines = (s) => (s.match(/\n/g) || []).length;
	for (const tk of tokens) {
		const start = row;
		row += lines(tk.raw);
		if (tk.type === "space") continue;
		if (tk.type !== "list") {
			blocks.push({ tk, start, end: start + lines(tk.raw.replace(/\n+$/, "")) });
			continue;
		}
		// a list is one block per item, so a change marks only its item
		let at = start;
		tk.items.forEach((item, i) => {
			const one = { ...tk, raw: item.raw, items: [item], start: tk.ordered ? (tk.start || 1) + i : "" };
			blocks.push({ tk: one, start: at, end: at + lines(item.raw.replace(/\n+$/, "")), item: true });
			at += lines(item.raw);
		});
	}
	for (const b of blocks) {
		const hit = hunks.filter((h) => h.from.row <= b.end && h.to.row >= b.start && !(h.to.row === b.start && h.to.col === 0 && h.from.row < b.start));
		b.kind = !hit.length ? null : hit.every((h) => h.op === "move") ? "moved"
			: hit.some((h) => h.op === "update") ? "updated" : side === "before" ? "removed" : "added";
	}
	const any = blocks.some((b) => b.kind);
	const show = blocks.map((b, i) => !any || [i - 1, i, i + 1].some((j) => blocks[j]?.kind));
	const out = [];
	let hidden = 0;
	const fold = () => {
		if (hidden) out.push(el("div", { class: "fold" }, `${hidden} unchanged block${hidden > 1 ? "s" : ""}`));
		hidden = 0;
	};
	blocks.forEach((b, i) => {
		if (!show[i]) return void hidden++;
		fold();
		const div = el("div", { class: `md-block${b.item ? " md-item" : ""}${b.kind ? ` changed md-${b.kind}` : ""}`, title: b.kind ?? null });
		div.innerHTML = lib.purify.sanitize(lib.marked.parser(Object.assign([b.tk], { links: tokens.links }))); // cleaned: no scripts or handlers
		roomForProse(div);
		out.push(div);
	});
	fold();
	return el("section", { class: `md-pane ${side}` },
		el("h4", {}, label ?? (side === "before" ? "Before" : "After"), el("span", { class: "sha" }, ref.slice(0, 7))),
		el("div", { class: "md-body" }, out));
}

// `github`: where to see it instead; `modes`: rendered/plain per path; `labels`: pane titles
// -- Explain a file's diff (SPEC 17) -----------------------------------------------
const explained = new Map(); // diff key -> text so far
const explaining = new Map(); // diff key -> "reading" | "writing" while the model works
const sideRef = (x) => x && { repo: x.repo, ref: x.ref, path: x.path };
const diffKey = (r) => JSON.stringify([sideRef(r.before), sideRef(r.after)]);
let explainFrame = 0;
const repaint = () => { explainFrame ||= requestAnimationFrame(() => { explainFrame = 0; render(); }); };

async function explain(r, pr) {
	const k = diffKey(r);
	if (explaining.has(k)) return;
	explaining.set(k, "reading");
	explained.set(k, "");
	render();
	try {
		await streamPost("/api/explain", { before: sideRef(r.before), after: sideRef(r.after), ...(pr ? { pr } : {}) }, (event, data) => {
			if (event === "stage") explaining.set(k, data.stage);
			else if (event === "message") explained.set(k, explained.get(k) + data.delta);
			else if (event === "done") explained.set(k, data.explanation), explainAsks.set(k, data.asks ?? []), explaining.delete(k);
			repaint();
		});
		if (explaining.has(k)) throw new Error("The explanation stopped before the end; try again");
	} catch (e) {
		explained.delete(k);
		toast(e.message);
	} finally {
		explaining.delete(k);
		render();
	}
}

function explainBox(r) {
	const k = diffKey(r);
	const text = explained.get(k);
	const stage = explaining.get(k);
	if (!text && !stage) return null;
	const live = stage ? " streaming" : "";
	return el("div", { class: `explain${live}`, role: "status" },
		text ? el("p", {}, inline(text)) : el("p", { class: "pending" }, stage === "reading" ? "Reading the changes…" : "Writing…"));
}

// Questions under an explanation: yours only, answered from the same changes and kept with it.
const explainAsks = new Map(); // diff key -> [{question, answer}]
const explainAsking = new Map(); // diff key -> {question, text, stage} while the model answers

async function explainAsk(r, pr) {
	const k = diffKey(r);
	const key = `explain-ask:${k}`;
	const question = (drafts.get(key) ?? "").trim();
	if (explainAsking.has(k)) return;
	if (!question) return toast("Write a question first");
	const run = { question, text: "", stage: "reading" };
	explainAsking.set(k, run);
	drafts.delete(key);
	render();
	try {
		let answer = null;
		await streamPost("/api/explain/ask", { before: sideRef(r.before), after: sideRef(r.after), ...(pr ? { pr } : {}), question }, (event, data) => {
			if (event === "stage") run.stage = data.stage;
			else if (event === "message") run.text += data.delta;
			else if (event === "done") answer = data.answer.trim();
			repaint();
		});
		if (answer === null) throw new Error("The answer stopped before the end; ask again");
		explainAsks.set(k, [...(explainAsks.get(k) ?? []), { question, answer }]);
	} catch (e) {
		if (!drafts.get(key)?.trim()) drafts.set(key, question); // the question is not lost
		toast(e.message);
	} finally {
		explainAsking.delete(k);
		render();
	}
}

function explainAskBox(r, pr) {
	const k = diffKey(r);
	if (!explained.get(k) || explaining.has(k)) return null; // only under a whole explanation
	const live = explainAsking.get(k);
	const send = () => explainAsk(r, pr);
	const turn = (x, streaming) => el("div", { class: `ask-turn${streaming ? " streaming" : ""}` },
		el("div", { class: "ask-q" }, x.question),
		streaming && !x.text ? el("p", { class: "ask-answer pending", role: "status" }, x.stage === "reading" ? "Reading the changes…" : "Writing…")
			: md(streaming ? x.text : x.answer, "ask-answer"));
	const box = draftBox(`explain-ask:${k}`, phone() ? "Ask about these changes" : "Ask about these changes (only you see it)", { rows: "1", "aria-label": "Your question about these changes" });
	box.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || !sendsOnEnter()) return;
		e.preventDefault();
		send();
	});
	return el("div", { class: "explain-ask", onclick: (e) => e.stopPropagation() },
		(explainAsks.get(k) ?? []).map((x) => turn(x, false)), live ? turn(live, true) : null,
		el("div", { class: "ask-form" }, box,
			el("button", { class: "primary ask-send", disabled: Boolean(live), onclick: send }, "Ask")));
}

function diffView(f, r, github, modes = files.mdMode, labels = {}, review = null, pr = null) {
	if (!r) return el("div", { class: "diff" }, el("p", { class: "pending" }, "Diffing…"));
	if (r.error) return el("div", { class: "diff" }, el("p", { class: "note" }, r.error));
	const link = el("a", { href: github, target: "_blank", rel: "noopener" }, "See it on GitHub");
	if (r.skipped) return el("div", { class: "diff" }, el("p", { class: "note" }, r.binary ? "Over 10 MB: not diffed. " : "Too large to diff. ", link));
	if (r.result.binary) return binaryView(f, r, link, modes);
	const note = NOTE[r.result.summary];
	const md = isMd(f.path);
	const rendered = md && modes.get(f.path) !== "plain";
	const lib = rendered ? loadMd() : null;
	const choose = (mode) => (e) => { e.stopPropagation(); modes.set(f.path, mode); render(); };
	const side = (name) => r[name] && (rendered
		? mdPane(name, r[name].ref, r[name].text, r.result[name].hunks, lib, labels[name])
		: pane(name, r[name].ref, r[name].text, r.result[name].hunks, labels[name], review));
	const canExplain = Boolean(data.pr?.summarize);
	return el("div", { class: `diff${r.before && r.after ? "" : " one-side"}` }, // a new or deleted file: nothing to compare
		md || canExplain ? el("div", { class: "diff-tools" },
			md ? el("div", { class: "md-switch seg", role: "group", "aria-label": "Show" },
				el("button", { "aria-pressed": String(rendered), class: rendered ? "on" : "", onclick: choose("rendered") }, "Rendered"),
				el("button", { "aria-pressed": String(!rendered), class: rendered ? "" : "on", onclick: choose("plain") }, "Plain diff")) : null,
			canExplain ? el("button", { class: "explain-btn", disabled: explaining.has(diffKey(r)), title: "Explain this file's changes (AI)",
				onclick: (e) => { e.stopPropagation(); explain(r, pr); } }, el("span", { class: "spark", "aria-hidden": "true" }, "✦"), "Explain") : null) : null,
		explainBox(r), explainAskBox(r, pr),
		note ? el("p", { class: "note" }, note) : null,
		rendered && review && (review.threads.length || review.commentable) ? el("p", { class: "note" }, "Line comments are on the Plain diff.") : null,
		rendered && !lib ? el("p", { class: "pending" }, "Rendering…")
			: !rendered && phone() ? unifiedView(r, labels, review)
			: el("div", { class: "panes" }, side("before"), side("after")));
}

// -- the diff on a phone (SPEC 15): one unified column ----------------------------------
const phone = () => matchMedia("(max-width: 720px)").matches;

// before and after as one sequence: unchanged lines once, then each run of removed
// lines followed by the added lines that replace them
function unify(a, b) {
	const rows = [];
	let i = 0, j = 0;
	const chA = (k) => a.marks[k].length > 0, chB = (k) => b.marks[k].length > 0;
	while (i < a.lines.length || j < b.lines.length) {
		if (i < a.lines.length && chA(i)) rows.push({ t: "del", i: i++ });
		else if (j < b.lines.length && chB(j)) rows.push({ t: "add", j: j++ });
		else if (i < a.lines.length && j < b.lines.length) {
			if (a.lines[i] === b.lines[j]) rows.push({ t: "ctx", i: i++, j: j++ });
			else rows.push({ t: "del", i: i++ }, { t: "add", j: j++ });
		} else if (i < a.lines.length) rows.push({ t: "del", i: i++ });
		else rows.push({ t: "add", j: j++ });
	}
	return rows;
}

function uLine(row, a, b, review) {
	const old = row.i !== undefined ? row.i + 1 : null, now = row.j !== undefined ? row.j + 1 : null;
	const del = row.t === "del";
	const k = del ? row.i : row.j;
	const [lines, marks] = del ? [a.lines, a.marks] : [b.lines, b.marks];
	return el("div", { class: `u-line u-${row.t}` },
		del ? lineNo(old, "LEFT", review) : el("span", { class: "ln old" }, old ?? ""),
		del ? el("span", { class: "ln new" }) : lineNo(now, "RIGHT", review),
		el("span", { class: "sign", "aria-hidden": "true" }, { del: "−", add: "+", ctx: "" }[row.t]),
		el("span", { class: "code" }, codeParts(lines[k], marks[k])));
}

function uExtras(row, review) {
	const out = [];
	const at = (side, n) => (review?.threads ?? []).filter((th) => th.side === side && th.line === n);
	if (row.t === "del") out.push(...at("LEFT", row.i + 1).map((th) => threadView(th, "files")));
	else out.push(...at("RIGHT", row.j + 1).map((th) => threadView(th, "files")));
	const f = review?.form;
	if (f?.subject === "line" && f.path === review.path && ((f.side === "LEFT" && row.t === "del" && f.line === row.i + 1) || (f.side === "RIGHT" && row.t !== "del" && f.line === row.j + 1))) out.push(commentForm(f));
	return out;
}

function unifiedView(r, labels, review) {
	const side = (name) => (r[name] ? markLines(name, r[name].text, r.result[name].hunks) : { lines: [], marks: [] });
	const a = side("before"), b = side("after");
	const rows = unify(a, b);
	const changed = rows.map((x) => x.t !== "ctx");
	const near = (k) => changed.slice(Math.max(0, k - 3), k + 4).some(Boolean);
	const show = rows.map((x, k) => near(k) || uExtras(x, review).length > 0);
	const out = [];
	let hidden = 0;
	const fold = () => { if (hidden) out.push(el("div", { class: "fold" }, `${hidden} unchanged line${hidden > 1 ? "s" : ""}`)); hidden = 0; };
	rows.forEach((x, k) => {
		if (!show[k]) return void hidden++;
		fold();
		out.push(uLine(x, a, b, review), ...uExtras(x, review));
	});
	fold();
	const head = (name, word) => (r[name] ? el("span", {}, labels[name] ?? word, " ", el("span", { class: "sha" }, r[name].ref.slice(0, 7))) : el("span", {}, name === "before" ? "New file" : "Deleted"));
	return el("div", { class: "unified" }, el("h4", { class: "u-head" }, head("before", "Before"), " → ", head("after", "After")), el("div", { class: "u-lines" }, out));
}

// the rows of a file list, each opening its diff. `opts` (SPEC 16, the PR's Files changed):
// viewed ticks, line comments and threads; `labels` names the two panes
function fileList(st, repo, github, opts = {}) {
	return el("ul", { class: "files" }, st.data.files.flatMap((f) => {
		const isOpen = st.open.has(f.path);
		const viewed = opts.viewed?.[f.path] === "VIEWED";
		const stop = (e) => e.stopPropagation();
		const tools = el("span", { class: "tools" },
			opts.pick ? pickButton(opts.pick(f)) : null,
			opts.onComment ? el("button", { class: "quiet file-comment", "aria-label": "Comment on file", title: "Comment on file", onclick: (e) => { stop(e); opts.onComment(f); } },
				el("span", { class: "long" }, "Comment on file"), el("span", { class: "short", "aria-hidden": "true" }, "💬")) : null,
			opts.onViewed ? (() => {
				const box = el("input", { type: "checkbox", class: "viewed", checked: viewed });
				box.addEventListener("change", () => opts.onViewed(f, box.checked));
				const lab = el("label", { class: `viewed-box${viewed ? " on" : ""}` }, box, "Viewed");
				lab.addEventListener("click", stop);
				return lab;
			})() : null);
		const row = el("li", { class: `file${isOpen ? " open" : ""}${viewed ? " is-viewed" : ""}`, role: "button", tabindex: "0", "aria-expanded": String(isOpen) },
			el("span", { class: `status s-${f.status}`, title: f.status }, STATUS[f.status] ?? "?"),
			el("span", { class: "path", title: f.previous ? `renamed from ${f.previous}` : null }, f.path),
			el("span", { class: "counts" }, el("span", { class: "add" }, `+${f.additions}`), " ", el("span", { class: "del" }, `−${f.deletions}`)),
			tools);
		const toggle = () => {
			if (isOpen) st.open.delete(f.path);
			else {
				st.open.add(f.path);
				if (!st.diffs.has(f.path)) { st.diffs.set(f.path, null); loadDiff(st, repo, f); }
			}
			render();
		};
		row.addEventListener("click", toggle);
		row.addEventListener("keydown", (e) => e.target === row && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
		const extra = opts.extra?.(f) ?? null; // a file comment form, outdated threads
		const review = opts.review?.(f) ?? null;
		return [row, extra, isOpen ? el("li", { class: "file-diff" }, diffView(f, st.diffs.get(f.path), github, st.mdMode, opts.labels, review, opts.pr ?? null)) : null];
	}));
}

// -- binary files (SPEC 15): pictures, and containers such as archives and PDFs ---------
const fileUrl = (s) => `/api/file?repo=${encodeURIComponent(s.repo)}&ref=${encodeURIComponent(s.ref)}&path=${encodeURIComponent(s.path)}`;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function pixelsText(p) {
	if (!p.regions.length) return "No visible change (only the bytes differ)";
	const pct = (100 * p.changed_pixels) / p.total_pixels;
	return `${pct < 0.1 ? "under 0.1" : pct.toFixed(1)}% of pixels changed in ${plural(p.regions.length, "area")}`;
}

// what changed between two pictures, in words
function pictureText(c) {
	const side = (s) => s && `${s.format} ${s.width}×${s.height}${s.frames ? `, ${s.frames} frames` : ""}`;
	const cmp = c.comparison;
	if (cmp.kind === "one_sided") return c.before ? `Removed: ${side(c.before)}` : `Added: ${side(c.after)}`;
	const sizes = `${side(c.before)} → ${side(c.after)}`;
	if (cmp.kind === "pixels") return `${sizes} · ${pixelsText(cmp)}`;
	if (cmp.kind === "resized") return `${sizes} · resized${cmp.aspect_kept ? ", same shape" : ""}${cmp.scaled ? ` · ${pixelsText(cmp.scaled)} (at the smaller size)` : ""}`;
	if (cmp.kind === "frames") {
		const changed = cmp.steps.filter((s) => s.kind !== "same").length;
		return `${sizes} · ${changed ? `${plural(changed, "frame step")} changed` : "frames look the same"}${cmp.retimed ? ", retimed" : ""}`;
	}
	return sizes;
}

// changed areas as outlines over a picture, in the picture's own pixels
function areas(regions, w, h) {
	return regions.map((r) => el("div", {
		class: "area", title: `${r.changed_pixels} pixels changed`,
		style: `left:${(100 * r.x) / w}%;top:${(100 * r.y) / h}%;width:${Math.max((100 * r.width) / w, 0.6)}%;height:${Math.max((100 * r.height) / h, 0.6)}%`,
	}));
}

function picPane(side, label, media, regions, w, h) {
	return el("section", { class: `pic-pane ${side}` }, el("h4", {}, label),
		el("div", { class: "pic-frame" }, media, w && h ? areas(regions, w, h) : null));
}

// the changed pixels lit up over a faint copy of the after picture
async function drawDifference(canvas, urlBefore, urlAfter) {
	const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
	const [a, b] = await Promise.all([load(urlBefore), load(urlAfter)]);
	const w = (canvas.width = b.naturalWidth), h = (canvas.height = b.naturalHeight);
	const px = (img) => { const c = new OffscreenCanvas(w, h).getContext("2d"); c.drawImage(img, 0, 0); return c.getImageData(0, 0, w, h).data; };
	const [da, db] = [px(a), px(b)];
	const out = canvas.getContext("2d").createImageData(w, h);
	for (let i = 0; i < out.data.length; i += 4) {
		const diff = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) + Math.abs(da[i + 3] - db[i + 3]);
		if (diff > 24) out.data.set([230, 60, 50, 255], i);
		else {
			const lum = 0.3 * db[i] + 0.59 * db[i + 1] + 0.11 * db[i + 2];
			const v = 255 - (255 - lum) * 0.22 * (db[i + 3] / 255);
			out.data.set([v, v, v, 255], i);
		}
	}
	canvas.getContext("2d").putImageData(out, 0, 0);
	canvas.dataset.drawn = "1";
}

function pictureView(f, r, c, modes) {
	const cmp = c.comparison;
	const before = r.before && fileUrl(r.before), after = r.after && fileUrl(r.after);
	const same = cmp.kind === "pixels";
	const key = `pic:${f.path}`;
	const mode = same ? modes.get(key) ?? "side" : "side";
	const regions = same ? cmp.regions : [];
	const choose = (m) => (e) => { e.stopPropagation(); modes.set(key, m); render(); };
	const img = (src, alt) => el("img", { src, alt, loading: "lazy" });
	let body;
	if (mode === "difference") {
		const canvas = el("canvas", { class: "pic-diff", "aria-label": "Changed pixels, lit up" });
		drawDifference(canvas, before, after).catch(() => toast("Could not draw the difference"));
		body = el("div", { class: "pic-frame single" }, canvas, areas(regions, c.after.width, c.after.height));
	} else if (mode === "slider") {
		const pos = modes.get(`${key}:pos`) ?? 50;
		const top = el("div", { class: "top", style: `clip-path: inset(0 0 0 ${pos}%)` }, img(after, "After"));
		const range = el("input", { type: "range", min: "0", max: "100", value: String(pos), "aria-label": "Before ← → After" });
		range.addEventListener("input", (e) => {
			modes.set(`${key}:pos`, e.target.value);
			top.setAttribute("style", `clip-path: inset(0 0 0 ${e.target.value}%)`);
		});
		range.addEventListener("click", (e) => e.stopPropagation());
		body = el("div", { class: "pic-slider" }, el("div", { class: "pic-frame single" }, img(before, "Before"), top), range);
	} else {
		body = el("div", { class: "pic-panes" },
			before ? picPane("before", "Before", img(before, "Before"), regions, c.before?.width, c.before?.height) : null,
			after ? picPane("after", "After", img(after, "After"), regions, c.after?.width, c.after?.height) : null);
	}
	return el("div", { class: "diff" },
		el("p", { class: "pic-info" }, pictureText(c)),
		same ? el("div", { class: "pic-modes seg", role: "group", "aria-label": "Show" },
			[["side", "Side by side"], ["difference", "Difference"], ["slider", "Slider"]].map(([m, name]) =>
				el("button", { class: mode === m ? "on" : "", "aria-pressed": String(mode === m), onclick: choose(m) }, name))) : null,
		body);
}

const FAMILY = { archives: "file", fonts: "part", documents: "part", catalogs: "message", cursors: "size" };

function memberText(m) {
	const d = m.detail;
	if (!d) return "";
	if (d.kind === "text") return `−${d.removed} +${d.added} lines${d.whitespace ? " (whitespace only)" : ""}`;
	if (d.kind === "picture") return d.comparison.kind === "pixels" ? pixelsText(d.comparison) : pictureText(d);
	if (d.kind === "binary") return `${fmtBytes(d.before_bytes)} → ${fmtBytes(d.after_bytes)}`;
	if (d.kind === "content") return d.content.kind === "container" ? `${plural(d.content.members.length, "change")} inside` : "picture changed";
	return "";
}

// SPEC 15: PDF pages drawn with pdf.js, loaded only when a PDF is opened
let pdfLib = null;
const pdfDocs = new Map(); // file url -> loading document
function pdfDoc(url) {
	pdfLib ??= import("/vendor/pdf-6.5.438.min.mjs").then((m) => {
		m.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker-6.5.438.min.mjs";
		return m;
	});
	if (!pdfDocs.has(url)) pdfDocs.set(url, pdfLib.then((m) => m.getDocument({ url, isEvalSupported: false }).promise));
	return pdfDocs.get(url);
}

async function drawPdfPage(canvas, url, number, width) {
	const doc = await pdfDoc(url);
	const page = await doc.getPage(number);
	const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
	canvas.dataset.drawn = "1";
}

function containerView(f, r, c, link) {
	const noun = FAMILY[c.family] ?? "member";
	const fmt = (c.before ?? c.after).format;
	const counts = c.before && c.after ? `${c.before.members} → ${plural(c.after.members, noun)}` : plural((c.before ?? c.after).members, noun);
	const order = { changed: 0, added: 1, removed: 2, same: 3 };
	const members = [...c.members].sort((a, b) => order[a.status] - order[b.status]);
	const pages = c.family === "documents"
		? members.filter((m) => /^page \d+$/.test(m.key) && m.status === "changed" && m.detail?.kind === "picture").slice(0, 10) : [];
	return el("div", { class: "diff" },
		el("p", { class: "members-head" }, `${fmt}: ${counts} · ${c.unchanged} unchanged`),
		el("ul", { class: "members" }, members.map((m) => el("li", { class: `member m-${m.status}` },
			el("span", { class: "key" }, m.key), el("span", { class: "status" }, m.status), el("span", { class: "how" }, memberText(m))))),
		pages.map((m) => {
			const n = Number(m.key.split(" ")[1]);
			const d = m.detail;
			const canvas = (side) => {
				const cv = el("canvas", { "aria-label": `${m.key}, ${side}` });
				drawPdfPage(cv, fileUrl(r[side]), n, d[side].width).catch(() => cv.replaceWith(el("p", { class: "note" }, "Could not draw this page.")));
				return cv;
			};
			return el("div", { class: "pdf-page" }, el("h5", {}, `Page ${n} · ${pixelsText(d.comparison)}`),
				el("div", { class: "pic-panes" },
					picPane("before", "Before", canvas("before"), d.comparison.regions ?? [], d.before.width, d.before.height),
					picPane("after", "After", canvas("after"), d.comparison.regions ?? [], d.after.width, d.after.height)));
		}),
		el("p", { class: "note" }, el("a", { href: link.getAttribute("href"), target: "_blank", rel: "noopener" }, "See it on GitHub")));
}

function binaryView(f, r, link, modes) {
	const c = r.result.content;
	if (!c) return el("div", { class: "diff" }, el("p", { class: "note" }, "Binary file: no content diff for this kind of file. ", link));
	if (c.kind === "picture") return pictureView(f, r, c, modes);
	if (c.kind === "container") return containerView(f, r, c, link);
	return el("div", { class: "diff" }, el("p", { class: "note" }, "Binary file: no content diff for this kind of file. ", link));
}

// -- compare two files (SPEC 15) -----------------------------------------------------
// picks: at most two files, kept in this tab while moving around
const onCompare = () => location.hash === "#compare";
let picks = (() => { try { return JSON.parse(sessionStorage.getItem("ghd-picks") || "[]"); } catch { return []; } })();
const savePicks = () => { try { sessionStorage.setItem("ghd-picks", JSON.stringify(picks)); } catch {} };
const pickKey = (p) => `${p.repo}@${p.ref}:${p.path}`;
const pickLabel = (p) => `${p.repo.split("/")[1]}#${p.number} ${p.path}`;

// the version a PR has now; a removed file at its last version
const pickOf = (t, f, d) => ({ repo: t.repo, number: t.number, path: f.path, ref: f.status === "removed" ? d.base : d.head });

function togglePick(p) {
	const i = picks.findIndex((x) => pickKey(x) === pickKey(p));
	if (i >= 0) picks.splice(i, 1);
	else {
		picks.push(p);
		if (picks.length > 2) picks.shift(); // a third pick replaces the oldest
	}
	savePicks();
	render();
}

function pickButton(p) {
	const on = picks.some((x) => pickKey(x) === pickKey(p));
	return el("button", { class: `pick quiet${on ? " on" : ""}`, "aria-pressed": String(on), title: "Pick this file to compare it with another",
		onclick: (e) => { e.stopPropagation(); togglePick(p); } }, on ? "Picked" : "Pick");
}

function renderTray() {
	let tray = $("#tray");
	if (!tray) document.body.append((tray = el("div", { id: "tray", role: "region", "aria-label": "Files to compare" })));
	const show = picks.length > 0 && !onCompare();
	tray.hidden = !show;
	document.body.classList.toggle("has-tray", show);
	if (!show) return;
	tray.replaceChildren(el("span", { class: "label" }, "Compare"),
		...picks.map((p) => el("span", { class: "picked" }, pickLabel(p),
			el("button", { class: "quiet", "aria-label": `Drop ${p.path}`, onclick: () => togglePick(p) }, "×"))),
		el("button", { class: "compare primary", disabled: picks.length < 2, onclick: () => (location.hash = "#compare") }, "Compare"));
}

let cmp = { key: null, result: null, modes: new Map() };

async function loadCompare(key, a, b) {
	const { status, data: r } = await api("/api/diff", { before: { repo: a.repo, ref: a.ref, path: a.path }, after: { repo: b.repo, ref: b.ref, path: b.path } });
	if (cmp.key !== key) return;
	cmp.result = status === 200 ? r : { error: r.error || `Could not compare (${status})` };
	render();
}

function renderCompare() {
	document.body.classList.add("files");
	document.body.classList.remove("settings");
	$("#tabs").hidden = true;
	const head = el("div", { class: "set-head" }, el("button", { id: "back", class: "quiet", onclick: () => history.back() }, "← Back"), el("h2", {}, "Compare"));
	if (picks.length < 2) {
		main.replaceChildren(el("div", { id: "compare-page" }, head, el("p", { class: "hint" }, "Pick two files in a PR's Files view first (Pick on each file).")));
		return;
	}
	const [a, b] = picks;
	const key = JSON.stringify([pickKey(a), pickKey(b)]);
	if (cmp.key !== key) {
		cmp = { key, result: null, modes: cmp.modes };
		loadCompare(key, a, b);
	}
	main.replaceChildren(el("div", { id: "compare-page" }, head,
		el("p", { class: "compare-what" }, el("span", {}, pickLabel(a)), el("span", { class: "arrow" }, " → "), el("span", {}, pickLabel(b)),
			el("button", { class: "quiet", onclick: () => { picks = [b, a]; savePicks(); render(); } }, "Swap")),
		diffView({ path: b.path }, cmp.result, `https://github.com/${b.repo}/blob/${b.ref}/${b.path}`, cmp.modes, { before: pickLabel(a), after: pickLabel(b) })));
}

// -- the PR page (SPEC 16) -------------------------------------------------------------
// GitHub's PR page, with omnidiff for every diff: Conversation, Commits, Checks, Files
// changed, the sidebar, the merge box and resolving conflicts. Everything acts as the
// person through /api/prs/<action>, then reads the PR again.
const PR_ROUTE = /^#pr\/([^/]+\/[^/]+)\/(\d+)(?:\/(commits|checks|files|guide|conflicts)(?:\/([\w.-]+))?)?$/;
const onPr = () => PR_ROUTE.test(location.hash);
function prTarget() {
	const m = location.hash.match(PR_ROUTE);
	return m && { repo: decodeURIComponent(m[1]), number: Number(m[2]), tab: m[3] ?? "conversation", sha: m[4] ?? null };
}
const prHash = (t, tab = "") => `#pr/${t.repo}/${t.number}${tab ? `/${tab}` : ""}`;

const freshPr = (key) => ({
	key, page: null, error: null, login: "", options: null, picker: null, mergeMenu: false, confirming: false, form: null, reviewOpen: false,
	commits: null, commitsError: null, commit: null, conflicts: null,
	guide: null, // SPEC 19: see freshGuide
});
let prv = freshPr(null);
// text being written (comments, replies, the review), by box; survives re-renders
const drafts = new Map();

async function loadPr() {
	const t = prTarget();
	if (!t) return;
	const key = `${t.repo}#${t.number}`;
	const { status, data: d } = await api(`/api/pr?repo=${encodeURIComponent(t.repo)}&number=${t.number}`);
	if (prv.key !== key) return;
	if (status === 200) Object.assign(prv, { page: d.page, login: d.login, error: null });
	else prv.error = d.error || `Could not load the pull request (${status})`;
	render();
}

async function loadOptions() {
	const t = prTarget();
	const { status, data: d } = await api(`/api/repo/options?repo=${encodeURIComponent(t.repo)}`);
	if (status === 200) prv.options = d;
	else toast(d.error || `Could not load the choices (${status})`);
	render();
}

/** One button on the page: POST as the person, say how it went, read the PR again. */
async function prPost(action, body = {}, done) {
	const t = prTarget();
	const { status, data: d } = await api(`/api/prs/${action}`, { repo: t.repo, number: t.number, ...body });
	if (status !== 200) {
		toast(d.error || `Failed (${status})`);
		return false;
	}
	if (done) toast(done);
	loadPr();
	return true;
}

function prEscape() {
	const t = prTarget();
	if (prv.picker || prv.mergeMenu || prv.confirming || prv.form || prv.reviewOpen || prv.guide?.editing || prv.guide?.ask) {
		Object.assign(prv, { picker: null, mergeMenu: false, confirming: false, form: null, reviewOpen: false });
		if (prv.guide) prv.guide.editing = prv.guide.ask = null;
		return render();
	}
	if (t.tab === "commits" && t.sha) return void (location.hash = prHash(t, "commits"));
	if (t.tab === "guide" && guideAt() !== null) return guideTo(null); // SPEC 19: from a step to the list of steps
	if (t.tab === "conflicts") return void (location.hash = prHash(t));
	goBack();
}

// -- text: Markdown from GitHub, cleaned; boxes that keep what is typed

function md(body, cls = "comment-body") {
	const d = el("div", { class: `${cls} md-body` });
	const lib = loadMd();
	if (!body?.trim()) d.append(el("p", { class: "hint" }, "No description provided."));
	else if (lib) d.innerHTML = lib.purify.sanitize(lib.marked.parse(body, { gfm: true, breaks: true })); // cleaned: no scripts or handlers
	else d.textContent = body;
	roomForProse(d);
	return d;
}

/** A table cell holding a sentence gets room to be read; the table scrolls sideways on a phone rather than squeezing it. */
function roomForProse(root) {
	for (const cell of root.querySelectorAll("td")) if (cell.textContent.trim().length > 40) cell.style.minWidth = "18em";
}

function draftBox(key, placeholder, attrs = {}) {
	const t = el("textarea", { "data-draft": key, placeholder, rows: "3", ...attrs });
	t.value = drafts.get(key) ?? "";
	t.addEventListener("input", () => drafts.set(key, t.value));
	return t;
}

const when = (iso) => el("time", { datetime: iso, title: new Date(iso).toLocaleString() }, `${age(iso)} ago`);

// -- threads and line comments

function hunkView(h) {
	const lines = h.split("\n").filter((l) => !l.startsWith("@@")).slice(-6);
	return el("pre", { class: "hunk" }, lines.map((l) => el("div", { class: l[0] === "+" ? "h-add" : l[0] === "-" ? "h-del" : "" }, l)));
}

function threadView(th, where) {
	const key = `reply:${th.id}`;
	const reply = async () => {
		const b = (drafts.get(key) ?? "").trim();
		if (!b) return toast("Write a reply first");
		if (await prPost("reply", { thread: th.id, body: b }, "Reply posted")) drafts.delete(key), render();
	};
	const body = [
		el("div", { class: "thread-head" }, el("span", { class: "thread-path" }, th.path),
			th.line ? el("span", { class: "thread-line" }, `line ${th.line}`) : null,
			th.outdated ? el("span", { class: "flag" }, "Outdated") : null,
			th.resolved ? el("span", { class: "flag" }, "Resolved") : null),
		where === "conversation" && th.diffHunk ? hunkView(th.diffHunk) : null,
		...th.comments.map((c) => el("div", { class: "thread-comment" },
			el("div", { class: "c-head" }, el("b", {}, c.author), " ", when(c.at), c.pending ? el("span", { class: "flag pending" }, "Pending") : null),
			md(c.body))),
		el("div", { class: "thread-reply" }, draftBox(key, "Reply…", { class: "reply", rows: "2" }),
			el("div", { class: "btns" },
				el("button", { onclick: busy(reply) }, "Reply"),
				el("button", { class: "quiet", onclick: busy(() => prPost("resolve-thread", { thread: th.id, resolved: !th.resolved }, th.resolved ? "Unresolved" : "Resolved")) },
					th.resolved ? "Unresolve conversation" : "Resolve conversation"))),
	];
	if (th.resolved && where === "conversation") return el("details", { class: "thread resolved" }, el("summary", {}, `${th.path}: resolved conversation`), ...body);
	return el("div", { class: "thread" }, ...body);
}

// the box under a line (or a file) for a new comment: posted now, or into the pending review
function commentForm(form) {
	const key = "form";
	const send = (mode) => async () => {
		const b = (drafts.get(key) ?? "").trim();
		if (!b) return toast("Write a comment first");
		const where = form.subject === "file" ? { subject: "file" } : { subject: "line", line: form.line, side: form.side };
		if (await prPost("review-comment", { mode, path: form.path, body: b, ...where }, mode === "single" ? "Comment posted" : "Added to your review")) {
			drafts.delete(key);
			prv.form = null;
			render();
		}
	};
	const pending = Boolean(prv.page?.pendingReview);
	return el("div", { class: "comment-form" },
		el("div", { class: "hint" }, form.subject === "file" ? `Comment on ${form.path}` : `Comment on line ${form.side === "LEFT" ? "−" : "+"}${form.line}`),
		draftBox(key, "Leave a comment"), // whoever opens the form puts the cursor in it: an autofocus box would take it again on every later render
		el("div", { class: "btns" },
			el("button", { class: "quiet", onclick: () => { prv.form = null; render(); } }, "Cancel"),
			el("button", { onclick: busy(send("single")) }, "Add single comment"),
			el("button", { class: "primary", onclick: busy(send("review")) }, pending ? "Add review comment" : "Start a review")));
}

// -- header, tabs and the page

const REVIEW_WORDS = { APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "commented", DISMISSED: "reviewed (dismissed)" };
const REVIEW_MARK = { APPROVED: ["✓", "ok"], CHANGES_REQUESTED: ["✎", "bad"], COMMENTED: ["💬", ""], DISMISSED: ["–", ""], REQUESTED: ["●", "wait"], PENDING: ["…", ""] };

function renderPr() {
	document.body.classList.add("files");
	document.body.classList.remove("settings");
	$("#tabs").hidden = true;
	const t = prTarget();
	const key = `${t.repo}#${t.number}`;
	if (prv.key !== key) {
		prv = freshPr(key);
		files = fileSet(key);
		loadPr();
	}
	if ((t.tab === "files" || t.tab === "guide") && files.key === key && !files.data && !files.error && !files.loading) {
		files.loading = true;
		loadFileSet(files, `/api/prs/files?repo=${encodeURIComponent(t.repo)}&number=${t.number}`);
	}
	// keep the focus and the caret in a box being typed in
	const focused = document.activeElement?.dataset?.draft;
	const caret = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;

	const p = prv.page;
	const back = el("div", { class: "set-head" },
		el("button", { id: "back", class: "quiet", onclick: () => (t.tab === "conflicts" ? (location.hash = prHash(t)) : goBack()) }, "← Back"),
		el("span", { class: "grow" }),
		el("a", { class: "btn quiet gh-link", href: p?.url ?? `https://github.com/${t.repo}/pull/${t.number}`, target: "_blank", rel: "noopener" }, "Open on GitHub"));
	if (!p) {
		main.replaceChildren(el("div", { id: "pr-page" }, back, el("p", { class: "hint" }, prv.error ?? "Loading the pull request…")));
		return;
	}
	if (t.tab === "conflicts") {
		main.replaceChildren(el("div", { id: "pr-page" }, back, conflictsView(t)));
		return refocus(focused, caret);
	}
	const state = p.state === "OPEN" ? (p.draft ? "Draft" : "Open") : p.state === "MERGED" ? "Merged" : "Closed";
	const head = el("header", { class: "pr-head" },
		el("h1", {}, p.title, " ", el("span", { class: "num" }, `#${p.number}`)),
		el("div", { class: "pr-sub" },
			el("span", { class: `state-badge st-${state.toLowerCase()}` }, state),
			el("span", { class: "pr-meta" }, el("b", {}, p.author), ` ${p.state === "MERGED" ? "merged" : "wants to merge"} ${plural(p.commits, "commit")} into `,
				el("code", {}, p.baseRef), " from ", el("code", {}, p.headRepo !== p.repo ? `${p.headRepo.split("/")[0]}:${p.headRef}` : p.headRef)),
			el("span", { class: "counts" }, el("span", { class: "add" }, `+${p.additions}`), " ", el("span", { class: "del" }, `−${p.deletions}`))));
	const talk = p.timeline.filter((x) => x.type === "comment" || x.type === "review").length;
	const left = prv.guide?.data ? prv.guide.data.steps.filter((x) => !x.reviewed).length : "";
	const tabs = [["", "Conversation", talk], ["commits", "Commits", p.commits], ["checks", "Checks", p.checks.length], ["files", "Files changed", p.changedFiles], ["guide", "Guided review", left]];
	const current = t.tab === "conversation" ? "" : t.tab;
	const nav = el("nav", { class: "pr-tabs", "aria-label": "Pull request" }, tabs.map(([id, name, n]) =>
		el("a", { href: prHash(t, id), class: id === current ? "on" : "", "aria-current": id === current ? "page" : null }, name, el("span", { class: "n" }, n))));
	const content = t.tab === "commits" ? commitsView(t) : t.tab === "checks" ? checksView(p) : t.tab === "files" ? filesChangedView(t, p)
		: t.tab === "guide" ? guideView(t, p) : conversationView(t, p);
	const conv = t.tab === "conversation";
	const g = t.tab === "guide" ? prv.guide : null;
	const step = g?.data ? guideAt() : null;
	if (step !== null) { // SPEC 19: a step has the page to itself
		document.body.classList.add("guiding");
		main.replaceChildren(el("div", { id: "pr-page", class: "guiding" }, content));
	} else main.replaceChildren(el("div", { id: "pr-page" }, back, head,
		el("div", { class: `pr-layout${conv ? "" : " wide"}` }, nav, el("section", { class: "pr-content" }, content), conv ? sidebar(p) : null)));
	if (g?.data && g.shown !== step) { // another step starts at its top; the list comes back at the step you left
		const from = g.shown;
		g.shown = step;
		if (step !== null || typeof from === "number") window.scrollTo(0, 0);
		if (step === null && typeof from === "number") main.querySelectorAll(".guide-row")[from]?.scrollIntoView({ block: "nearest" });
	}
	const on = nav.querySelector(".on"); // on a phone the tabs scroll sideways: keep this one in sight
	const past = on ? on.getBoundingClientRect().right - nav.getBoundingClientRect().right : 0;
	if (past > 0) nav.scrollLeft += past + 16;
	refocus(focused, caret);
}

function refocus(key, caret) {
	if (!key) return;
	const box = main.querySelector(`[data-draft="${CSS.escape(key)}"]`);
	if (!box) return;
	box.focus();
	if (caret) box.setSelectionRange(caret[0], caret[1]);
}

// -- Conversation

function conversationView(t, p) {
	const byReview = new Map();
	for (const th of p.threads) if (th.reviewId) byReview.set(th.reviewId, [...(byReview.get(th.reviewId) ?? []), th]);
	const box = (type, who, verb, at, body, extra = []) => el("article", { class: "tl tl-box", "data-type": type },
		el("div", { class: "tl-head" }, el("b", {}, who), ` ${verb} `, when(at)), body, ...extra);
	const items = [box("description", p.author, "opened this", p.createdAt, md(p.body))];
	for (const x of p.timeline) {
		if (x.type === "comment") items.push(box("comment", x.author, "commented", x.at, md(x.body)));
		else if (x.type === "review") {
			const [mark, tone] = REVIEW_MARK[x.state] ?? ["", ""];
			items.push(el("article", { class: `tl tl-box review r-${tone}`, "data-type": "review" },
				el("div", { class: "tl-head" }, el("span", { class: `rv-mark ${tone}`, "aria-hidden": "true" }, mark), el("b", {}, x.author), ` ${REVIEW_WORDS[x.state] ?? "reviewed"} `, when(x.at)),
				x.body ? md(x.body) : null,
				(byReview.get(x.id) ?? []).map((th) => threadView(th, "conversation"))));
		} else if (x.type === "commit") {
			items.push(el("div", { class: "tl tl-line", "data-type": "commit" }, el("span", { class: "dot", "aria-hidden": "true" }),
				el("span", { class: "msg" }, x.message), el("span", { class: "who" }, x.author), el("code", { class: "sha" }, x.sha.slice(0, 7))));
		} else items.push(el("div", { class: "tl tl-line", "data-type": "event" }, el("span", { class: "dot", "aria-hidden": "true" }), eventText(x), " ", when(x.at)));
	}
	return el("div", { class: "conversation" }, el("div", { class: "timeline" }, items), mergeBox(t, p), commentBox(p));
}

function eventText(x) {
	const s = x.subject ?? "";
	const what = {
		labeled: `added the ${s} label`, unlabeled: `removed the ${s} label`, assigned: `assigned ${s}`, unassigned: `unassigned ${s}`,
		review_requested: `requested a review from ${s}`, review_request_removed: `removed the request for review from ${s}`,
		ready_for_review: "marked this pull request as ready for review", convert_to_draft: "marked this pull request as draft",
		head_ref_force_pushed: "force-pushed the branch", merged: "merged this", closed: "closed this", reopened: "reopened this",
	}[x.event] ?? x.event;
	return el("span", {}, el("b", {}, x.actor), ` ${what}`);
}

const METHOD = { merge: ["Merge pull request", "Create a merge commit"], squash: ["Squash and merge", "Squash and merge"], rebase: ["Rebase and merge", "Rebase and merge"] };
function mergeMethod(p) {
	let m = null;
	try { m = localStorage.getItem(`ghd-merge:${p.repo}`); } catch {}
	return p.mergeMethods.includes(m) ? m : p.mergeMethods[0] ?? "merge";
}

function mergeBox(t, p) {
	if (p.state === "MERGED") return el("div", { class: "merge-box done" }, el("p", { class: "mb-branch" }, "Pull request successfully merged and closed."));
	if (p.state === "CLOSED") return el("div", { class: "merge-box done" }, el("p", { class: "mb-branch" }, "This pull request is closed."));
	const review = { APPROVED: ["ok", "Changes approved"], CHANGES_REQUESTED: ["bad", "Changes requested"], REVIEW_REQUIRED: ["wait", "Review required"] }[p.reviewDecision] ?? ["", "No review required"];
	const states = p.checks.map((c) => c.state);
	const checks = !states.length ? ["", "No checks"]
		: states.includes("failed") ? ["bad", "Some checks were not successful"]
		: states.some((s) => s === "running" || s === "queued") ? ["wait", "Some checks haven't completed yet"]
		: ["ok", "All checks have passed"];
	const conflicts = p.mergeable === "CONFLICTING" || p.mergeState === "DIRTY";
	let branch;
	if (p.draft) branch = el("div", { class: "mb-branch wait" }, el("p", {}, "This pull request is still a work in progress"),
		el("button", { onclick: busy(() => prPost("draft", { draft: false }, "Ready for review")) }, "Ready for review"));
	else if (conflicts) branch = el("div", { class: "mb-branch bad" }, el("p", {}, "This branch has conflicts that must be resolved"),
		el("button", { onclick: () => (location.hash = prHash(t, "conflicts")) }, "Resolve conflicts"));
	else if (p.mergeState === "BEHIND") branch = el("div", { class: "mb-branch wait" }, el("p", {}, "This branch is out-of-date with the base branch"),
		el("button", { onclick: busy(() => prPost("update-branch", {}, "Updating the branch")) }, "Update branch"));
	else if (p.mergeable === "UNKNOWN") branch = el("div", { class: "mb-branch" }, el("p", {}, "Checking for the ability to merge automatically…"));
	else branch = el("div", { class: "mb-branch ok" }, el("p", {}, "This branch has no conflicts with the base branch"));
	const method = mergeMethod(p);
	const can = !p.draft && !conflicts && p.mergeMethods.length > 0;
	const split = el("div", { class: "merge-split" },
		el("button", { class: "merge-btn primary", disabled: !can, onclick: () => { prv.confirming = true; prv.mergeMenu = false; render(); } }, METHOD[method][0]),
		el("button", { class: "merge-menu-toggle primary", disabled: !can, "aria-label": "Select merge method", "aria-expanded": String(prv.mergeMenu),
			onclick: () => { prv.mergeMenu = !prv.mergeMenu; render(); } }, "▾"),
		prv.mergeMenu ? el("div", { class: "merge-menu", role: "menu" }, p.mergeMethods.map((m) => el("button", { role: "menuitemradio", "aria-checked": String(m === method),
			onclick: () => { try { localStorage.setItem(`ghd-merge:${p.repo}`, m); } catch {} prv.mergeMenu = false; render(); } }, METHOD[m][1]))) : null);
	let confirmStep = null;
	if (prv.confirming && can) {
		const title = method === "merge" ? `Merge pull request #${p.number} from ${p.headRepo.split("/")[0]}/${p.headRef}` : `${p.title} (#${p.number})`;
		const tIn = el("input", { class: "merge-title", value: title, "aria-label": "Commit title" });
		const msg = el("textarea", { class: "merge-message", rows: "3", placeholder: "Add an optional extended description…", "aria-label": "Commit message" });
		const go = async () => {
			const body = { confirm: true, method, ...(method !== "rebase" ? { title: tIn.value } : {}), ...(method !== "rebase" && msg.value.trim() ? { message: msg.value } : {}) };
			if (await prPost("merge", body, "Merged")) { prv.confirming = false; setTimeout(load, 1500); }
		};
		confirmStep = el("div", { class: "merge-confirm" }, method !== "rebase" ? [tIn, msg] : el("p", { class: "hint" }, "The commits are added onto the base branch one by one."),
			el("div", { class: "btns" }, el("button", { class: "primary", onclick: busy(go) }, "Confirm merge"), el("button", { class: "quiet", onclick: () => { prv.confirming = false; render(); } }, "Cancel")));
	}
	return el("div", { class: "merge-box" },
		el("p", { class: `mb-review ${review[0]}` }, review[1]),
		el("p", { class: `mb-checks ${checks[0]}` }, checks[1], " ", p.checks.length ? el("a", { href: prHash(t, "checks") }, "Show all checks") : null),
		branch, confirmStep ?? split);
}

function commentBox(p) {
	const send = async () => {
		const b = (drafts.get("new") ?? "").trim();
		if (!b) return toast("Write a comment first");
		if (await prPost("comment", { body: b }, "Comment posted")) drafts.delete("new"), render();
	};
	const close = async () => {
		const b = (drafts.get("new") ?? "").trim();
		if (!confirm(`Close pull request #${p.number}?\n\n${p.title}`)) return;
		if (b && !(await prPost("comment", { body: b }))) return;
		drafts.delete("new");
		if (await prPost("close", { confirm: true }, "Closed")) setTimeout(load, 1500);
	};
	const hasText = Boolean((drafts.get("new") ?? "").trim());
	const box = draftBox("new", "Leave a comment", { id: "new-comment", rows: "4" });
	const closeBtn = p.state === "OPEN" ? el("button", { class: "close-pr", onclick: busy(close) }, hasText ? "Close with comment" : "Close pull request")
		: p.state === "CLOSED" ? el("button", { onclick: busy(() => prPost("reopen", {}, "Reopened")) }, "Reopen pull request") : null;
	box.addEventListener("input", () => closeBtn?.classList.contains("close-pr") && (closeBtn.textContent = box.value.trim() ? "Close with comment" : "Close pull request"));
	return el("div", { class: "comment-box" }, box, el("div", { class: "btns" }, closeBtn, el("button", { class: "primary", onclick: busy(send) }, "Comment")));
}

// -- sidebar

function sidebar(p) {
	const gear = (kind, what) => el("button", { class: "quiet gear", "aria-label": `Edit ${what}`, "aria-expanded": String(prv.picker === kind),
		onclick: () => { prv.picker = prv.picker === kind ? null : kind; if (prv.picker && !prv.options) loadOptions(); render(); } }, "⚙");
	const part = (kind, title, ...body) => el("section", { class: `side-${kind}` }, el("div", { class: "side-head" }, el("h3", {}, title), gear(kind, title.toLowerCase())),
		prv.picker === kind ? picker(kind, p) : null, ...body);
	const me = prv.login;
	return el("aside", { class: "sidebar" },
		part("reviewers", "Reviewers",
			p.reviewers.length ? el("ul", { class: "people" }, p.reviewers.map((r) => {
				const [mark, tone] = REVIEW_MARK[r.state] ?? ["", ""];
				return el("li", {}, el("span", { class: "who" }, r.login ?? r.team), el("span", { class: `rv-mark ${tone}`, title: r.state.toLowerCase().replace("_", " ") }, mark),
					r.login && r.state !== "REQUESTED" && p.state === "OPEN" ? el("button", { class: "quiet rerequest", "aria-label": `Re-request review from ${r.login}`, title: "Re-request review",
						onclick: busy(() => prPost("reviewers", { add: [r.login], remove: [] }, `Review requested from ${r.login}`)) }, "↻") : null);
			})) : el("p", { class: "hint" }, "No reviews"),
			p.state === "OPEN" && !p.draft ? el("p", { class: "hint" }, "Still in progress? ",
				el("button", { class: "link", onclick: busy(() => prPost("draft", { draft: true }, "Converted to draft")) }, "Convert to draft")) : null),
		part("assignees", "Assignees",
			p.assignees.length ? el("ul", { class: "people" }, p.assignees.map((a) => el("li", {}, el("span", { class: "who" }, a))))
				: el("p", { class: "hint" }, "No one—", el("button", { class: "link", onclick: busy(() => prPost("assignees", { logins: [me] }, "Assigned to you")) }, "assign yourself"))),
		part("labels", "Labels",
			p.labels.length ? el("div", { class: "labels" }, p.labels.map((l) => labelChip(l))) : el("p", { class: "hint" }, "None yet")),
		part("milestone", "Milestone", el("p", { class: p.milestone ? "" : "hint" }, p.milestone?.title ?? "No milestone")));
}

function labelChip(l) {
	const c = /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : "#888888";
	return el("span", { class: "label-chip", style: `--c:${c}` }, l.name);
}

function picker(kind, p) {
	const o = prv.options;
	if (!o) return el("div", { class: "picker" }, el("p", { class: "hint" }, "Loading…"));
	let items;
	if (kind === "reviewers") items = o.assignable.filter((l) => l.toLowerCase() !== p.author.toLowerCase())
		.map((l) => ({ name: l, on: p.reviewers.some((r) => r.login === l && r.state === "REQUESTED"), set: (on) => prPost("reviewers", on ? { add: [l], remove: [] } : { add: [], remove: [l] }) }));
	else if (kind === "assignees") items = o.assignable.map((l) => ({ name: l, on: p.assignees.includes(l),
		set: (on) => prPost("assignees", { logins: on ? [...p.assignees, l] : p.assignees.filter((x) => x !== l) }) }));
	else if (kind === "labels") items = o.labels.map((l) => ({ name: l.name, chip: l, on: p.labels.some((x) => x.name === l.name),
		set: (on) => prPost("labels", { names: on ? [...p.labels.map((x) => x.name), l.name] : p.labels.map((x) => x.name).filter((x) => x !== l.name) }) }));
	else items = [{ name: "No milestone", number: null }, ...o.milestones.map((m) => ({ name: m.title, number: m.number }))]
		.map((m) => ({ name: m.name, on: (p.milestone?.number ?? null) === m.number, set: () => prPost("milestone", { milestone: m.number }) }));
	if (!items.length) return el("div", { class: "picker" }, el("p", { class: "hint" }, "Nothing to choose from"));
	return el("div", { class: "picker", role: "group", "aria-label": kind }, items.map((i) => {
		const input = el("input", { type: kind === "milestone" ? "radio" : "checkbox", name: `pick-${kind}`, checked: i.on });
		input.addEventListener("change", () => i.set(input.checked));
		return el("label", {}, input, i.chip ? labelChip(i.chip) : el("span", {}, i.name));
	}));
}

// -- Checks

const CHECK_WORD = { passed: ["✓", "Passed", "ok"], failed: ["✗", "Failed", "bad"], running: ["●", "Running", "wait"], queued: ["○", "Queued", "wait"],
	skipped: ["–", "Skipped", ""], cancelled: ["⊘", "Cancelled", ""], neutral: ["–", "Neutral", ""] };

function took(c) {
	if (!c.startedAt || !c.completedAt) return "";
	const s = Math.max(0, Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function checksView(p) {
	if (!p.checks.length) return el("p", { class: "hint" }, "No checks on the latest commit.");
	const failed = p.checks.some((c) => c.state === "failed");
	return el("div", { class: "checks-view" },
		el("div", { class: "checks-head" }, el("span", {}, `${plural(p.checks.length, "check")} on ${p.headSha.slice(0, 7)}`),
			failed && p.state === "OPEN" ? el("button", { onclick: busy(() => prPost("rerun", {}, "Re-running failed jobs")) }, "Re-run failed jobs") : null),
		el("ul", { class: "checks" }, p.checks.map((c) => {
			const [mark, word, tone] = CHECK_WORD[c.state] ?? CHECK_WORD.neutral;
			return el("li", { class: `check ${tone}` }, el("span", { class: "check-mark", "aria-hidden": "true" }, mark),
				el("span", { class: "check-name" }, c.workflow ? `${c.workflow} / ${c.name}` : c.name),
				el("span", { class: "check-state" }, word), el("span", { class: "check-time" }, took(c)),
				c.url ? el("a", { class: "details", href: c.url, target: "_blank", rel: "noopener" }, "Details") : el("span", {}));
		})));
}

// -- Commits

async function loadCommits(t) {
	const key = prv.key;
	const { status, data: d } = await api(`/api/prs/commits?repo=${encodeURIComponent(t.repo)}&number=${t.number}`);
	if (prv.key !== key) return;
	if (status === 200) prv.commits = d;
	else prv.commitsError = d.error || `Could not load the commits (${status})`;
	render();
}

function commitsView(t) {
	if (t.sha) return commitView(t);
	if (!prv.commits && !prv.commitsError && !prv.commitsLoading) { prv.commitsLoading = true; loadCommits(t); }
	if (!prv.commits) return el("p", { class: "hint" }, prv.commitsError ?? "Loading the commits…");
	const days = new Map();
	for (const c of prv.commits) {
		const day = new Date(c.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(c.at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
		days.set(day, [...(days.get(day) ?? []), c]);
	}
	return el("div", { class: "commits-view" }, [...days].flatMap(([day, cs]) => [
		el("h4", { class: "commit-day" }, `Commits on ${day}`),
		el("ul", { class: "commits" }, cs.map((c) => {
			const li = el("li", { class: "commit", role: "button", tabindex: "0" }, el("span", { class: "msg" }, c.message), el("span", { class: "who" }, c.author),
				el("code", { class: "sha" }, c.sha.slice(0, 7)), when(c.at));
			const go = () => (location.hash = `${prHash(t, "commits")}/${c.sha}`);
			li.addEventListener("click", go);
			li.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
			return li;
		}))]));
}

function commitView(t) {
	if (prv.commit?.key !== t.sha) {
		prv.commit = fileSet(t.sha);
		loadFileSet(prv.commit, `/api/commit/files?repo=${encodeURIComponent(t.repo)}&sha=${encodeURIComponent(t.sha)}`);
	}
	const st = prv.commit;
	const c = prv.commits?.find((x) => x.sha === t.sha);
	return el("div", { class: "commit-view" },
		el("p", {}, el("a", { href: prHash(t, "commits") }, "← All commits")),
		el("h3", { class: "commit-title" }, c?.message ?? t.sha.slice(0, 7), " ", el("code", { class: "sha" }, t.sha.slice(0, 7))),
		st.data ? fileList(st, t.repo, `https://github.com/${t.repo}/commit/${t.sha}`, { labels: { before: "Parent", after: "This commit" } })
			: el("p", { class: "hint" }, st.error ?? "Loading the files…"));
}

// -- Files changed: omnidiff diffs plus GitHub's review tools

function filesChangedView(t, p) {
	if (!files.data) return el("p", { class: "hint" }, files.error ?? "Loading the files…");
	const total = files.data.files.length;
	const seen = files.data.files.filter((f) => p.viewed?.[f.path] === "VIEWED").length;
	const pending = p.pendingReview?.comments ?? 0;
	const own = p.author.toLowerCase() === prv.login.toLowerCase();
	const head = el("div", { class: "files-head" },
		el("span", { class: "hint" }, `${plural(total, "changed file")}, compared with where the branch left its base · ${seen} / ${total} files viewed`),
		p.state === "OPEN" ? el("button", { class: "review-changes primary", "aria-expanded": String(prv.reviewOpen), onclick: () => { prv.reviewOpen = !prv.reviewOpen; render(); } },
			"Review changes", pending ? el("span", { class: "n" }, pending) : null) : null);
	const form = prv.reviewOpen && p.state === "OPEN" ? reviewForm(p, own) : null;
	const prUrl = p.url;
	const list = fileList(files, t.repo, `${prUrl}/files`, {
		pick: (f) => pickOf(t, f, files.data),
		pr: { repo: t.repo, number: t.number },
		viewed: p.viewed,
		onViewed: async (f, on) => {
			p.viewed = { ...p.viewed, [f.path]: on ? "VIEWED" : "UNVIEWED" }; // at once; GitHub keeps it
			if (on) files.open.delete(f.path);
			render();
			const { status, data: d } = await api("/api/prs/viewed", { repo: t.repo, number: t.number, path: f.path, viewed: on });
			if (status !== 200) {
				p.viewed = { ...p.viewed, [f.path]: on ? "UNVIEWED" : "VIEWED" };
				toast(d.error || `Failed (${status})`);
				render();
			}
		},
		onComment: p.state === "OPEN" ? (f) => { prv.form = { subject: "file", path: f.path }; render(); main.querySelector(".comment-form textarea")?.focus(); } : null,
		extra: (f) => {
			const old = p.threads.filter((th) => th.path === f.path && (th.outdated || !th.line));
			const fileForm = prv.form?.subject === "file" && prv.form.path === f.path ? commentForm(prv.form) : null;
			return fileForm || old.length ? el("li", { class: "file-extra" }, fileForm, old.map((th) => threadView(th, "files"))) : null;
		},
		review: (f) => ({
			path: f.path,
			commentable: p.state === "OPEN" ? f.commentable : null,
			threads: p.threads.filter((th) => th.path === f.path && th.line && !th.outdated),
			form: prv.form,
			onAdd: (side, line) => { prv.form = { subject: "line", path: f.path, side, line }; render(); main.querySelector(".comment-form textarea")?.focus(); },
		}),
	});
	return el("div", { class: "files-changed" }, head, form, list);
}

function reviewForm(p, own) {
	const events = own ? [["COMMENT", "Comment", "Submit general feedback without explicit approval."]] : [
		["COMMENT", "Comment", "Submit general feedback without explicit approval."],
		["APPROVE", "Approve", "Submit feedback and approve merging these changes."],
		["REQUEST_CHANGES", "Request changes", "Submit feedback that must be addressed before merging."]];
	const chosen = drafts.get("review-event") ?? "COMMENT";
	const submit = async () => {
		const event = main.querySelector(".review-form input[name=event]:checked")?.value ?? "COMMENT";
		if (await prPost("submit-review", { event, body: drafts.get("review") ?? "" }, "Review submitted")) {
			drafts.delete("review");
			drafts.delete("review-event");
			prv.reviewOpen = false;
		}
	};
	const cancel = async () => {
		if (!confirm("Cancel your review? Its pending comments are deleted.")) return;
		if (await prPost("cancel-review", {}, "Review cancelled")) prv.reviewOpen = false;
	};
	return el("div", { class: "review-form" },
		el("h4", {}, "Finish your review"),
		draftBox("review", "Leave a comment", { class: "review-body", rows: "4" }),
		el("div", { class: "events", role: "radiogroup" }, events.map(([v, name, hint]) => {
			const r = el("input", { type: "radio", name: "event", value: v, checked: v === chosen || (own && v === "COMMENT") });
			r.addEventListener("change", () => drafts.set("review-event", v));
			return el("label", {}, r, el("span", {}, el("b", {}, name), el("span", { class: "hint" }, hint)));
		})),
		el("div", { class: "btns" },
			p.pendingReview ? el("button", { class: "quiet", onclick: busy(cancel) }, "Cancel review") : null,
			el("button", { class: "primary", onclick: busy(submit) }, "Submit review")));
}

// -- guided review (SPEC 19) ------------------------------------------------------------
// The server prepares the PR (noise hidden, steps in reading order, checked drafts). Here
// the tab lists the steps, and one step opens alone (…/guide/<k>), where the person
// decides its drafts and ticks its files off, with one key per decision.

/** "12 s", "3 min 05 s": how long since `iso`, for a wait that is refreshed every second. */
function elapsed(iso) {
	const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

// `open`: the files of the step that show their diff; `cur`: the file the keys v and c act
// on; `entered`: the step `open` was set up for; `fromList`: Back leads to the list;
// `ask`: the question box is open ({ about }); `asking`: the question the AI is answering
const freshGuide = () => ({
	data: null, failed: null, editing: null, loading: false, preparing: false, progress: null,
	open: new Set(), cur: null, entered: null, shown: undefined, fromList: false,
	ask: null, asking: null, askPin: true, askTop: 0,
});

const guideHash = (t, k = null) => prHash(t, k === null ? "guide" : `guide/${k + 1}`);

/** The step that is open alone (its index), or null on the list of steps. */
function guideAt() {
	const t = prTarget();
	const steps = prv.guide?.data?.steps;
	if (t?.tab !== "guide" || !steps || !/^\d+$/.test(t.sha ?? "")) return null;
	const k = Number(t.sha) - 1;
	return k >= 0 && k < steps.length ? k : null;
}

/** Where the review goes on: the first changed step, else the first not reviewed (-1: none). */
function guideNext(d) {
	const changed = d.steps.findIndex((x) => x.changed);
	return changed >= 0 ? changed : d.steps.findIndex((x) => !x.reviewed);
}

/** Open step `k`, or the list (null, or past either end). The list stays one Back away. */
function guideTo(k) {
	const t = prTarget();
	const g = prv.guide;
	const from = guideAt();
	if (k !== null && (k < 0 || k >= g.data.steps.length)) k = null;
	g.editing = g.ask = null;
	prv.form = null;
	if (from === null && k !== null) {
		g.fromList = true;
		location.hash = guideHash(t, k);
	} else if (from !== null && k === null && g.fromList) history.back();
	else {
		history.replaceState(null, "", guideHash(t, k));
		render();
	}
}

async function loadGuide(t) {
	const key = prv.key;
	const { status, data: d } = await api(`/api/review?repo=${encodeURIComponent(t.repo)}&number=${t.number}`);
	if (prv.key !== key) return;
	const g = prv.guide;
	g.loading = false;
	if (status !== 200) g.failed = d.error || `Could not load the guided review (${status})`;
	else if (d.state === "failed") g.failed = d.error;
	else if (d.state === "preparing") {
		g.failed = null;
		g.preparing = true;
		g.progress = d.progress ?? null;
		setTimeout(() => prv.key === key && prTarget()?.tab === "guide" && loadGuide(t), 1000);
	} else Object.assign(g, { data: d, failed: null, preparing: false });
	render();
}

async function guidePost(what, body) {
	const t = prTarget();
	const { status, data: d } = await api(`/api/review/${what}`, { repo: t.repo, number: t.number, ...body });
	if (status !== 200) toast(d.error || `Failed (${status})`);
	return status === 200;
}

const openDraft = (step) => step?.drafts.find((d) => d.state === "open") ?? null;

// a decided draft leaves the queue at once (the next key goes to the next draft), and
// comes back if the server refuses
async function keepDraft(d, body) {
	const g = prv.guide;
	d.state = "saving";
	if (!(await guidePost("draft", { draft: d.id, action: "keep", ...(body === undefined ? {} : { body }) }))) return void ((d.state = "open"), render());
	d.state = "kept";
	if (g.editing === d.id) g.editing = null;
	drafts.delete(`gdraft:${d.id}`);
	toast("Added to your review");
	render();
	loadPr(); // the pending count
}

async function dropDraft(d) {
	d.state = "saving";
	render();
	if (!(await guidePost("draft", { draft: d.id, action: "drop" }))) return void ((d.state = "open"), render());
	d.state = "dropped";
	render();
}

function editDraft(d) {
	const g = prv.guide;
	g.editing = d.id;
	if (!drafts.has(`gdraft:${d.id}`)) drafts.set(`gdraft:${d.id}`, d.body);
	render();
	main.querySelector(".draft.editing textarea")?.focus();
}

/** Looks good: the whole step is reviewed; on to the next one that is not, else the list. */
async function lookGood() {
	const g = prv.guide;
	const k = guideAt();
	if (k === null) return;
	const step = g.data.steps[k];
	if (!step.reviewed) {
		if (!(await guidePost("step", { step: step.id, reviewed: true }))) return;
		Object.assign(step, { reviewed: true, changed: false, stale: [], seen: [...step.files] });
	}
	if (guideAt() !== k) return render();
	const next = g.data.steps.findIndex((x, i) => i > k && !x.reviewed);
	guideTo(next >= 0 ? next : null);
}

const fileRow = (path) => main.querySelector(`.guide-files .file[data-path="${CSS.escape(path)}"]`);

/** Viewed: the file folds away and the next one to read opens. Shown at once, undone if the server refuses. */
async function viewFile(step, path, on) {
	const g = prv.guide;
	const before = { seen: step.seen, stale: step.stale, reviewed: step.reviewed, changed: step.changed };
	step.seen = on ? [...new Set([...step.seen, path])] : step.seen.filter((x) => x !== path);
	if (on) step.stale = step.stale.filter((x) => x !== path);
	step.reviewed = step.files.every((x) => step.seen.includes(x));
	step.changed = !step.reviewed && step.stale.length > 0;
	if (on) {
		g.open.delete(path);
		g.cur = step.files.find((x) => !step.seen.includes(x)) ?? null;
		if (g.cur) g.open.add(g.cur);
	} else g.cur = path;
	render();
	if (on && g.cur) fileRow(g.cur)?.scrollIntoView({ block: "start" });
	if (await guidePost("file", { path, reviewed: on })) return;
	Object.assign(step, before);
	render();
}

function commentOn(path) {
	prv.form = { subject: "file", path };
	render();
	main.querySelector(".guide-step .comment-form textarea")?.focus();
}

/** One key, one decision. True when the key was used. */
function guideKey(k) {
	const g = prv.guide;
	if (!g?.data) return false;
	const at = guideAt();
	if (at === null) { // the list: Enter goes on with the review
		const next = guideNext(g.data);
		if (k !== "Enter" || next < 0 || document.activeElement?.closest?.("a, button, summary, label")) return false;
		return guideTo(next), true;
	}
	const step = g.data.steps[at];
	const d = openDraft(step);
	if (k === "b") return guideTo(at - 1), true;
	if (k === "s") return guideTo(at + 1), true;
	if (k === "y") return lookGood(), true;
	if (k === "v" && g.cur) return viewFile(step, g.cur, true), true;
	if (k === "k" && d) return keepDraft(d), true;
	if (k === "e" && d) return editDraft(d), true;
	if (k === "x" && d) return dropDraft(d), true;
	if (k === "c") return commentOn(g.cur ?? step.files[0]), true;
	if (k === "a" && g.data.ai) return openAsk(), true;
	return false;
}

/** The folder every file of a step is in, said once above them ("" for one file, or none in common). */
function commonDir(paths) {
	if (paths.length < 2) return "";
	const dirs = paths.map((x) => x.split("/").slice(0, -1));
	let n = 0;
	while (dirs.every((x) => x.length > n && x[n] === dirs[0][n])) n++;
	return n ? `${dirs[0].slice(0, n).join("/")}/` : "";
}

const meter = (done, total) => el("span", { class: "meter", "aria-hidden": "true" }, el("span", { style: `width:${total ? (100 * done) / total : 100}%` }));
const stepFlags = (s) => [
	s.reviewed ? el("span", { class: "flag ok" }, "Reviewed") : null,
	s.changed ? el("span", { class: "flag changed" }, "Changed") : null,
	s.skim ? el("span", { class: "flag" }, "Skim") : null,
];

// a draft comment: where it is, the lines of code it is about, what it says
function draftView(d, current, short) {
	const g = prv.guide;
	const where = `${short(d.path)}:${d.side === "LEFT" ? "−" : "+"}${d.line}`;
	const editing = g.editing === d.id;
	const cls = `draft ${d.state}${editing ? " editing" : ""}${current ? " current" : ""}`;
	const code = d.code?.length ? el("div", { class: "draft-code" }, d.code.map((c) =>
		el("div", { class: `dc dc-${c.mark === "+" ? "add" : c.mark === "-" ? "del" : "ctx"}${c.hit ? " hit" : ""}` },
			el("span", { class: "ln" }, c.n), el("span", { class: "sign", "aria-hidden": "true" }, c.mark === "-" ? "−" : c.mark.trim()), el("span", { class: "code" }, c.text)))) : null;
	if (editing) {
		return el("div", { class: cls },
			el("div", { class: "draft-where" }, where),
			code,
			draftBox(`gdraft:${d.id}`, "Edit the comment", { rows: "3" }),
			el("div", { class: "btns" },
				el("button", { class: "quiet", onclick: () => { g.editing = null; render(); } }, "Cancel"),
				el("button", { class: "primary", onclick: busy(() => keepDraft(d, (drafts.get(`gdraft:${d.id}`) ?? "").trim())) }, "Keep")));
	}
	return el("div", { class: cls },
		el("div", { class: "draft-where" }, el("span", { class: "flag ai" }, "AI draft"), " ", where,
			d.state !== "open" ? el("span", { class: "flag" }, { kept: "Kept", dropped: "Dropped", saving: "Saving…" }[d.state]) : null),
		d.state === "open" ? code : null,
		el("p", { class: "draft-body" }, d.body),
		d.state === "open" ? el("div", { class: "btns" },
			el("button", { class: "quiet ask-about", title: "Ask the AI about this comment", onclick: () => openAsk({ path: d.path, draft: d.id, side: d.side, line: d.line }) },
				el("span", { class: "spark", "aria-hidden": "true" }, "✦"), "Ask"),
			el("button", { class: "quiet", onclick: busy(() => dropDraft(d)) }, "Drop", el("kbd", {}, "x")),
			el("button", { onclick: () => editDraft(d) }, "Edit", el("kbd", {}, "e")),
			el("button", { onclick: busy(() => keepDraft(d)) }, "Keep", el("kbd", {}, "k"))) : null);
}

function guideView(t, p) {
	if (!prv.guide) prv.guide = freshGuide();
	const g = prv.guide;
	if (!g.data && !g.failed && !g.loading && !g.preparing) {
		g.loading = true;
		loadGuide(t);
	}
	if (g.failed) {
		const retry = async () => {
			if (!(await guidePost("prepare", {}))) return;
			Object.assign(g, { failed: null, preparing: true });
			render();
			loadGuide(t);
		};
		return el("div", { class: "guide" }, el("p", { class: "hint" }, `Could not prepare the guided review: ${g.failed}`),
			el("div", {}, el("button", { onclick: busy(retry) }, "Try again")));
	}
	if (!g.data) {
		const q = g.progress;
		const what = !q ? "the AI reads the changes, one step at a time…"
			: q.phase === "queued" ? "waiting for the review of the push before this one…"
			: q.phase === "reading" ? `reading the changed files (${q.done} of ${q.total})…`
			: q.phase === "planning" ? `the AI is grouping ${q.total} files into steps (a minute or three on a big one)…`
			: q.phase === "reviewing" ? `the AI is reviewing step ${q.done + 1} of ${q.total}: ${q.what}…`
			: `the AI is checking its draft comments on step ${q.done + 1} of ${q.total}: ${q.what}…`;
		const total = q && (q.phase === "reviewing" || q.phase === "checking") ? q.total : 0;
		return el("div", { class: "guide guide-preparing" },
			el("p", { class: "hint" }, `${q?.push ? "Updating the guided review after a push" : "Preparing the guided review"}: ${what}`),
			total ? el("p", { class: "guide-progress" }, meter(q.done, total)) : null,
			q?.since ? el("p", { class: "hint" }, `Working for ${elapsed(q.since)}`) : null);
	}
	const k = guideAt();
	return k === null ? guideList(t, p, g.data) : guideStepView(t, p, g.data, k);
}

// the tab: what the PR does, how far the review is, and the steps to open
function guideList(t, p, d) {
	const g = prv.guide;
	const n = d.steps.length;
	const done = d.steps.filter((x) => x.reviewed).length;
	const changed = d.steps.filter((x) => x.changed).length;
	const next = guideNext(d);
	const all = n > 0 && done === n;
	const byPath = new Map((files.data?.files ?? []).map((f) => [f.path, f]));
	const noise = d.noise.length ? el("details", { class: "guide-noise" },
		el("summary", {}, `${plural(d.noise.length, "file")} hidden: no real change to review`),
		el("ul", {}, d.noise.map((x) => el("li", {}, el("code", {}, x.path), ` · ${x.why}`)))) : null;
	const head = [
		d.summary ? el("p", { class: "guide-summary" }, d.summary) : null,
		d.note ? el("p", { class: "hint" }, d.note) : null,
		changed ? el("p", { class: "guide-changed" }, `${plural(changed, "step")} changed since your review`) : null];
	if (!n) return el("div", { class: "guide" }, head, el("p", { class: "hint" }, "Nothing to review: every changed file is noise."), noise);

	g.fromList = false;
	const sizes = d.steps.map((s) => s.files.map((x) => byPath.get(x)).filter(Boolean).reduce((a, f) => [a[0] + f.additions, a[1] + f.deletions], [0, 0]));
	const most = Math.max(1, ...sizes.map(([a, b]) => a + b));
	const rows = d.steps.map((s, k) => {
		const fs = s.files.map((x) => byPath.get(x)).filter(Boolean);
		const [adds, dels] = sizes[k];
		const open = s.drafts.filter((x) => x.state === "open").length;
		return el("li", {}, el("a", { class: `guide-row${s.reviewed ? " done" : ""}${k === next ? " next" : ""}`, href: guideHash(t, k), onclick: () => { g.fromList = true; } },
			el("span", { class: "guide-num", "aria-hidden": "true" }, s.reviewed ? "✓" : k + 1),
			el("span", { class: "guide-row-text" },
				el("span", { class: "guide-row-title" }, s.title, stepFlags(s)),
				s.summary ? el("span", { class: "guide-row-summary" }, s.summary) : null,
				el("span", { class: "guide-row-meta" },
					el("span", {}, plural(s.files.length, "file")),
					fs.length ? el("span", { class: "counts" }, el("span", { class: "add" }, `+${adds}`), " ", el("span", { class: "del" }, `−${dels}`)) : null,
					s.drafts.length ? el("span", { class: open ? "ai" : "" }, open ? `${plural(open, "AI comment")} to decide` : `${plural(s.drafts.length, "AI comment")} decided`) : null)),
			// how big the step is next to the others, at a glance
			adds + dels ? el("span", { class: "guide-size", "aria-hidden": "true", title: `${adds + dels} changed lines` },
				el("span", { class: "add", style: `width:${(100 * adds) / most}%` }), el("span", { class: "del", style: `width:${(100 * dels) / most}%` })) : null));
	});

	const pending = p.pendingReview?.comments ?? 0;
	const own = p.author.toLowerCase() === prv.login.toLowerCase();
	const canSubmit = p.state === "OPEN";
	if (prv.reviewOpen && !drafts.has("review") && d.summary) drafts.set("review", d.summary);
	const finish = all || done > 0 || pending > 0 ? el("div", { class: `guide-done${all ? " all" : ""}` },
		el("div", { class: "guide-done-text" },
			el("h3", {}, all ? `All ${n} steps reviewed` : `${done} of ${n} steps reviewed`),
			el("p", {}, `${plural(pending, "pending comment")} in your review.`)),
		canSubmit && !prv.reviewOpen ? el("button", { class: all ? "primary" : "", onclick: () => { prv.reviewOpen = true; render(); } }, "Submit review") : null,
		canSubmit && prv.reviewOpen ? reviewForm(p, own) : null) : null;

	return el("div", { class: "guide" }, head,
		el("div", { class: "guide-top" },
			el("p", { class: "guide-progress" }, `${done} of ${n} steps reviewed`, meter(done, n)),
			next >= 0 ? el("button", { class: "primary", onclick: () => guideTo(next) }, done || changed ? `Continue with step ${next + 1}` : "Start review", el("kbd", {}, "↵")) : null),
		all ? finish : null,
		el("ol", { class: "guide-steps" }, rows),
		all ? null : finish,
		noise);
}

/** On entering a step: a small step opens whole, a big one at its first file to read, data stays folded. */
function enterStep(step) {
	const g = prv.guide;
	const todo = step.files.filter((x) => !step.seen.includes(x)).map((x) => files.data.files.find((f) => f.path === x)).filter(Boolean);
	const lines = todo.reduce((a, f) => a + f.additions + f.deletions, 0);
	const small = todo.length <= 8 && lines <= 400;
	g.open = new Set(step.skim ? [] : (small ? todo : todo.slice(0, 1)).map((f) => f.path));
	g.cur = todo[0]?.path ?? null;
	g.entered = step.id;
}

// one step alone: what it does, what the AI flagged, and its files to tick off
function guideStepView(t, p, d, k) {
	const g = prv.guide;
	const step = d.steps[k];
	const n = d.steps.length;
	const done = d.steps.filter((x) => x.reviewed).length;
	if (files.data && g.entered !== step.id) enterStep(step);
	const dir = commonDir(step.files);
	const short = (path) => path.slice(dir.length);
	const current = openDraft(step);
	const canComment = p.state === "OPEN";
	const stop = (e) => e.stopPropagation();

	const rows = step.files.map((path) => {
		const f = files.data?.files.find((x) => x.path === path);
		if (!f) return el("li", { class: "hint" }, files.error ?? `Loading ${short(path)}…`);
		const isOpen = g.open.has(path);
		const seen = step.seen.includes(path);
		if (isOpen && !files.diffs.has(path)) {
			files.diffs.set(path, null);
			loadDiff(files, t.repo, f);
		}
		const box = el("input", { type: "checkbox", class: "viewed", checked: seen });
		box.addEventListener("change", () => viewFile(step, path, box.checked));
		const viewed = el("label", { class: `viewed-box${seen ? " on" : ""}` }, box, "Viewed");
		viewed.addEventListener("click", stop);
		const row = el("div", { class: `file${isOpen ? " open" : ""}${seen ? " is-viewed" : ""}${g.cur === path ? " cur" : ""}`, "data-path": path, role: "button", tabindex: "0", "aria-expanded": String(isOpen) },
			el("span", { class: `status s-${f.status}`, title: f.status }, STATUS[f.status] ?? "?"),
			el("span", { class: "path", title: f.previous ? `renamed from ${f.previous}` : path }, short(path),
				step.stale.includes(path) ? el("span", { class: "flag changed" }, "Changed") : null,
				step.notes[path] ? el("span", { class: "file-note" }, step.notes[path]) : null),
			el("span", { class: "counts" }, el("span", { class: "add" }, `+${f.additions}`), " ", el("span", { class: "del" }, `−${f.deletions}`)),
			el("span", { class: "tools" },
				canComment ? el("button", { class: "quiet file-comment", "aria-label": "Comment on file", title: "Comment on file", onclick: (e) => { stop(e); g.cur = path; commentOn(path); } },
					el("span", { class: "long" }, "Comment"), el("span", { class: "short", "aria-hidden": "true" }, "💬")) : null,
				d.ai ? el("button", { class: "quiet file-comment file-ask", "aria-label": "Ask the AI about this file", title: "Ask the AI about this file", onclick: (e) => { stop(e); openAsk({ path }); } },
					el("span", { class: "long" }, "Ask"), el("span", { class: "short", "aria-hidden": "true" }, "✦")) : null,
				viewed));
		const toggle = () => {
			if (isOpen) g.open.delete(path);
			else g.open.add(path), (g.cur = path);
			render();
		};
		row.addEventListener("click", toggle);
		row.addEventListener("keydown", (e) => e.target === row && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
		// one item per file, so its row stays on top only while its own diff is on screen
		return el("li", { class: "guide-file" }, row,
			prv.form?.subject === "file" && prv.form.path === path ? el("div", { class: "file-extra" }, commentForm(prv.form)) : null,
			isOpen ? el("div", { class: "file-diff" }, diffView(f, files.diffs.get(path), `${p.url}/files`, files.mdMode, undefined, {
				path, commentable: canComment ? f.commentable : null,
				threads: p.threads.filter((th) => th.path === path && th.line && !th.outdated),
				form: prv.form,
				onAdd: (side, line) => { prv.form = { subject: "line", path, side, line }; render(); main.querySelector(".comment-form textarea")?.focus(); },
			}, { repo: t.repo, number: t.number })) : null);
	});

	const read = plural(step.files.length, "file");
	const decided = step.drafts.length > 0 && !current;
	const ai = step.skim ? "Data and figures: the AI did not read these. Skim them and tick them off."
		: !d.ai ? null
		: step.drafts.length ? `The AI read ${read} and flagged ${plural(step.drafts.length, "line")}.${decided ? " All decided." : ""}`
		: `The AI read ${read} and found nothing to flag.`;
	const last = !d.steps.some((x, i) => i > k && !x.reviewed);
	return el("div", { class: "guide" },
		el("div", { class: "guide-bar" },
			el("button", { class: "quiet", onclick: () => guideTo(null) }, "‹ Steps"),
			el("p", { class: "guide-progress" }, `Step ${k + 1} of ${n}`, meter(done, n)),
			el("span", { class: "hint" }, `${done} reviewed`)),
		el("article", { class: "guide-step" },
			el("h2", {}, step.title, stepFlags(step)),
			step.summary ? el("p", { class: "guide-step-summary" }, step.summary) : null,
			ai ? el("p", { class: "guide-ai" }, ai) : null,
			step.drafts.length ? el("div", { class: "drafts" }, step.drafts.map((x) => draftView(x, x === current, short))) : null,
			el("p", { class: "guide-files-head" }, el("b", {}, `${step.seen.length} of ${step.files.length} viewed`), dir ? el("span", {}, "in ", el("code", {}, dir)) : null),
			el("ul", { class: "files guide-files" }, rows)),
		el("div", { class: `guide-foot${g.ask ? " asking" : ""}` },
			g.ask ? askDock(t, step, short, canComment) : null,
			el("div", { class: "guide-keys btns" },
				el("button", { class: "quiet", onclick: () => guideTo(k - 1) }, "Back", el("kbd", {}, "b")),
				canComment ? el("button", { class: "quiet wide", onclick: () => commentOn(g.cur ?? step.files[0]) }, "Comment", el("kbd", {}, "c")) : null,
				d.ai ? el("button", { class: `quiet ask-open${g.ask ? " on" : ""}`, "aria-expanded": String(Boolean(g.ask)), title: "Ask the AI about this step",
					onclick: () => (g.ask ? ((g.ask = null), render()) : openAsk()) }, "Ask", step.asks.length ? el("span", { class: "n" }, step.asks.length) : null, el("kbd", {}, "a")) : null,
				el("button", { class: "quiet", onclick: () => guideTo(k + 1) }, "Skip", el("kbd", {}, "s")),
				g.cur && !step.reviewed ? el("button", { onclick: busy(() => viewFile(step, g.cur, true)) }, "Viewed", el("kbd", {}, "v")) : null,
				el("button", { class: "primary", onclick: busy(lookGood) }, !step.reviewed ? "Looks good" : last ? "Done" : "Next step", el("kbd", {}, "y")))));
}

// -- SPEC 19, Ask: questions about a step. Yours alone: nothing here goes to GitHub

const askTag = (a, short) => (a.draft ? `${short(a.path)}:${a.side === "LEFT" ? "−" : "+"}${a.line}` : short(a.path));
// with a keyboard Enter sends the question; on a phone it is a new line, and the button sends
const sendsOnEnter = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Open the question box with the cursor in it: about a file or a draft, or (null) the whole step. */
function openAsk(about) {
	const g = prv.guide;
	g.ask = { about: about === undefined ? g.ask?.about ?? null : about };
	g.askPin = true;
	render();
	main.querySelector(".ask-dock textarea")?.focus();
}

async function ask(t, step) {
	const g = prv.guide;
	const key = `ask:${step.id}`;
	const question = (drafts.get(key) ?? "").trim();
	if (g.asking) return;
	if (!question) return toast("Write a question first");
	const about = g.ask?.about ?? null;
	const run = (g.asking = { step: step.id, question, about, text: "", stage: "reading" });
	g.askPin = true;
	drafts.delete(key);
	render();
	try {
		let answer = null;
		const body = { repo: t.repo, number: t.number, step: step.id, question, ...(about ? { about: about.draft ? { draft: about.draft } : { path: about.path } } : {}) };
		await streamPost("/api/review/ask", body, (event, data) => {
			if (event === "stage") run.stage = data.stage;
			else if (event === "message") run.text += data.delta;
			else if (event === "done") answer = data.answer.trim();
			repaint();
		});
		if (answer === null) throw new Error("The answer stopped before the end; ask again");
		step.asks.push({ question, answer, about, at: new Date().toISOString() });
	} catch (e) {
		if (!drafts.get(key)?.trim()) drafts.set(key, question); // the question is not lost
		toast(e.message);
	} finally {
		g.asking = null;
		render();
	}
}

/** The answer becomes a comment to edit: on the line of the draft it was about, else on the file. */
function useAnswer(step, turn) {
	const g = prv.guide;
	const a = turn.about;
	const path = a && step.files.includes(a.path) ? a.path : g.cur ?? step.files[0];
	const f = files.data?.files.find((x) => x.path === path);
	const diffed = files.diffs.get(path)?.result;
	const onLine = a?.draft && a.path === path && diffed && !diffed.binary && inRanges(f?.commentable?.[a.side === "LEFT" ? "left" : "right"], a.line);
	const had = (drafts.get("form") ?? "").trim();
	drafts.set("form", had ? `${had}\n\n${turn.answer}` : turn.answer);
	if (onLine) {
		g.open.add(path);
		if (isMd(path)) files.mdMode.set(path, "plain"); // a line's comment box is under the line of the source
		prv.form = { subject: "line", path, side: a.side, line: a.line };
	} else prv.form = { subject: "file", path };
	g.cur = path;
	g.ask = null;
	render();
	const box = main.querySelector(".guide-step .comment-form textarea");
	box?.scrollIntoView({ block: "center" });
	box?.focus({ preventScroll: true });
}

// the questions and answers of this step, and the box for the next one, over the buttons at the bottom
function askDock(t, step, short, canComment) {
	const g = prv.guide;
	const key = `ask:${step.id}`;
	const live = g.asking?.step === step.id ? g.asking : null;
	const about = g.ask.about;
	const send = () => ask(t, step);
	const focus = () => main.querySelector(".ask-dock textarea")?.focus();
	const turn = (x, streaming) => el("div", { class: `ask-turn${streaming ? " streaming" : ""}` },
		el("div", { class: "ask-q" }, x.about ? el("span", { class: "ask-tag" }, askTag(x.about, short)) : null, x.question),
		streaming && !x.text ? el("p", { class: "ask-answer pending", role: "status" }, x.stage === "reading" ? "Reading the changes…" : "Writing…")
			: md(streaming ? x.text : x.answer, "ask-answer"),
		!streaming && canComment ? el("div", { class: "ask-tools" },
			el("button", { class: "quiet ask-use", title: "Start a comment with this answer; you edit it before it is added", onclick: () => useAnswer(step, x) }, "Use as comment")) : null);
	const thread = el("div", { class: "ask-thread" },
		step.asks.length || live ? null : el("p", { class: "hint" }, "Ask what a change does, why it is there, or what it could break. The AI answers from the changes of this step."),
		step.asks.map((x) => turn(x, false)), live ? turn(live, true) : null);
	// the thread stays where it was read; at its end it follows the answer as it comes in
	thread.addEventListener("scroll", () => {
		g.askTop = thread.scrollTop;
		g.askPin = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
	});
	queueMicrotask(() => { thread.scrollTop = g.askPin ? thread.scrollHeight : g.askTop; });
	const box = draftBox(key, about ? "Your question about it" : "Your question about this step", { rows: "2", "aria-label": "Your question" });
	box.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || !sendsOnEnter()) return;
		e.preventDefault();
		send();
	});
	return el("section", { class: "ask-dock", "aria-label": "Ask the AI about this step" },
		el("div", { class: "ask-head" },
			el("b", {}, el("span", { class: "spark", "aria-hidden": "true" }, "✦"), "Ask the AI"),
			el("span", { class: "hint" }, "Only you see this"),
			el("button", { class: "quiet ask-close", "aria-label": "Close", title: "Close", onclick: () => { g.ask = null; render(); } }, "✕")),
		thread,
		about ? el("div", { class: "ask-chip" }, about.draft ? `About the AI draft on ${askTag(about, short)}` : `About ${askTag(about, short)}`,
			el("button", { class: "quiet", "aria-label": "Ask about the whole step instead", title: "Ask about the whole step instead", onclick: () => { g.ask.about = null; render(); focus(); } }, "✕")) : null,
		el("div", { class: "ask-form" }, box,
			el("button", { class: "primary ask-send", disabled: Boolean(g.asking), onclick: send }, "Ask", el("kbd", {}, "↵"))));
}

// -- resolving conflicts

const CONFLICT = /^<{7}[^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}[^\n]*(?:\n|$)/gm;
const hasMarkers = (text) => /^(<{7}|>{7})( |$)|^={7}$/m.test(text);
const countConflicts = (text) => [...text.matchAll(CONFLICT)].length;
function acceptBlock(text, k, how) {
	let i = 0;
	return text.replace(CONFLICT, (m, ours, theirs) => (i++ !== k ? m : how === "current" ? ours : how === "incoming" ? theirs : ours + theirs));
}

async function loadConflicts(t) {
	const key = prv.key;
	const { status, data: d } = await api(`/api/prs/conflicts?repo=${encodeURIComponent(t.repo)}&number=${t.number}`);
	if (prv.key !== key) return;
	prv.conflicts = status === 200
		? { data: d, text: new Map(d.files.map((f) => [f.path, f.text])), resolved: new Set() }
		: { error: d.error || `Could not read the conflicts (${status})` };
	render();
}

function conflictsView(t) {
	if (!prv.conflicts) {
		prv.conflicts = { loading: true };
		loadConflicts(t);
	}
	const c = prv.conflicts;
	const title = el("h2", { class: "conflicts-title" }, "Resolve conflicts");
	if (!c.data) return el("div", { id: "conflicts-page" }, title, el("p", { class: "hint" }, c.error ?? "Reading the conflicts…"));
	const d = c.data;
	const ready = !d.unsupported.length && d.files.length > 0 && d.files.every((f) => c.resolved.has(f.path));
	const commit = async () => {
		const body = { head: d.head, files: d.files.map((f) => ({ path: f.path, text: c.text.get(f.path) })) };
		if (await prPost("resolve-conflicts", body, "Merge commit made")) {
			prv.conflicts = null;
			location.hash = prHash(t);
		}
	};
	return el("div", { id: "conflicts-page" }, title,
		el("p", { class: "hint" }, `Merging `, el("code", {}, d.baseRef), ` into `, el("code", {}, d.headRef), `: ${plural(d.files.length, "conflicting file")}.`),
		d.unsupported.length ? el("div", { class: "unsupported" }, el("p", {}, "These conflicts are too complex to resolve here. Resolve this on the command line:"),
			el("ul", {}, d.unsupported.map((u) => el("li", {}, el("code", {}, u.path), `: ${u.why}`)))) : null,
		d.files.map((f) => conflictFile(f, c)),
		el("div", { class: "btns commit-merge" }, el("button", { class: "primary", disabled: !ready, onclick: busy(commit) }, "Commit merge")));
}

function conflictFile(f, c) {
	const area = el("textarea", { class: "conflict-text", spellcheck: "false", "aria-label": `${f.path}, with conflict markers`, rows: "16" });
	area.value = c.text.get(f.path);
	const tools = el("div", { class: "conflict-tools" });
	const mark = el("button", {}, "Mark as resolved");
	const refresh = () => {
		const n = countConflicts(area.value);
		tools.replaceChildren(...Array.from({ length: n }, (_, k) => el("div", { class: "conflict-pick" },
			n > 1 ? el("span", { class: "hint" }, `Conflict ${k + 1}`) : null,
			...[["current", "Accept current change"], ["incoming", "Accept incoming change"], ["both", "Accept both changes"]].map(([how, name]) =>
				el("button", { class: "quiet", onclick: () => { area.value = acceptBlock(area.value, k, how); changed(); } }, name)))));
		mark.disabled = hasMarkers(area.value) || c.resolved.has(f.path);
		mark.textContent = c.resolved.has(f.path) ? "✓ Resolved" : "Mark as resolved";
	};
	const changed = () => {
		c.text.set(f.path, area.value);
		if (c.resolved.delete(f.path)) return render(); // edited after marking: not resolved any more
		refresh();
	};
	area.addEventListener("input", changed);
	mark.addEventListener("click", () => { c.resolved.add(f.path); render(); });
	refresh();
	return el("section", { class: `conflict-file${c.resolved.has(f.path) ? " resolved" : ""}` },
		el("div", { class: "conflict-head" }, el("span", { class: "path" }, f.path), mark), tools, area);
}

window.addEventListener("hashchange", () => render());
$("#settings-btn").onclick = () => openSettings();
$("#bell").onclick = () => openSettings("notifications");
$("#reload").onclick = load;
$("#keys-btn").onclick = () => help().showModal();
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && (load(), onPr() && loadPr())); // SPEC 8, 16
load();
