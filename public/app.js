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
// mirrors readyToMerge in src/inbox.ts: only then is Merge the highlighted button
const ready = (pr) => !pr.draft && pr.mergeable !== "CONFLICTING" && ["success", "none"].includes(pr.checks) && [null, "APPROVED"].includes(pr.reviewDecision);
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

function summaryBox(kind, item) {
	const s = summaries.get(`${kind}:${keyOf(item)}`);
	if (!s) return null;
	const lines = s.split("\n").map((l) => l.trim().replace(/^[-*•]\s*/, "")).filter(Boolean);
	const rows = lines.map((l) => l.match(/^(What|Status|Next):\s*(.+)$/i)).filter(Boolean);
	// SPEC 12: three labelled rows; a summary kept in the older bullet form shows as a list
	if (rows.length && rows.length === lines.length) {
		return el("dl", { class: "summary" }, rows.flatMap(([, label, text]) => [el("dt", {}, label[0].toUpperCase() + label.slice(1).toLowerCase()), el("dd", {}, inline(text))]));
	}
	return el("div", { class: "summary" }, el("ul", {}, lines.map((l) => el("li", {}, inline(l)))));
}

async function summarize(kind, item) {
	toast("Summarizing…");
	const { status, data: d } = await api("/api/summarize", { kind, repo: item.repo, number: item.number });
	if (status === 200) {
		summaries.set(`${kind}:${keyOf(item)}`, d.summary);
		view.expanded = true;
		toast("Summary ready");
		render();
	} else toast(d.error || `Summary failed (${status})`);
}

// -- the triage list (SPEC 13) ------------------------------------------------------
// One line per item. One row is selected; when `expanded`, the selected row shows its
// details and actions under it. Everything below works the same from keys and taps.

// what each key does to the selected item; returns a reason when it does not apply
const ACTIONS = {
	open: (x) => { window.open(x.url, "_blank", "noopener"); },
	approve: (x, k) => (k !== "pr" ? "Issues cannot be approved" : x.author.toLowerCase() === data.login.toLowerCase() ? "You cannot approve your own PR" : doAction(x, "approve")),
	merge: (x, k) => (k !== "pr" ? "Issues cannot be merged" : confirm(`Merge ${keyOf(x)}?\n\n${x.title}`) ? doAction(x, "merge", { confirm: true }) : null),
	rerun: (x, k) => (k !== "pr" || x.checks !== "failure" ? "No failed checks to re-run" : doAction(x, "rerun")),
	comment: async (x, k) => {
		if (k !== "pr") return "Comment on issues on GitHub";
		const b = prompt(`Comment on ${keyOf(x)}`);
		if (b && b.trim()) await doAction(x, "comment", { body: b });
	},
	summarize: (x, k) => (data[k]?.summarize ? summarize(k, x) : "Summaries are not set up"),
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
const KEYS = { Enter: "open", o: "open", a: "approve", m: "merge", r: "rerun", c: "comment", s: "summarize", h: "hide" };

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
	const mine = x.author.toLowerCase() === data.login.toLowerCase();
	const facts = kind === "pr"
		? [CHECKS[x.checks]?.[1], REVIEW[x.reviewDecision]?.[1], x.draft ? "draft" : null, x.mergeable === "CONFLICTING" ? "merge conflicts" : null, `updated ${age(x.updatedAt)} ago`]
		: [x.assignees.length ? `assigned to ${x.assignees.join(", ")}` : "unassigned", x.comments ? `${x.comments} comments` : null, ...x.labels, `updated ${age(x.updatedAt)} ago`];
	const btn = (key, label, name, cls = "") => el("button", { class: cls, onclick: busy(() => act(name, entry)) }, el("kbd", {}, key), label);
	return el("div", { class: "detail" },
		el("div", { class: "facts" }, facts.filter(Boolean).join(" · ")),
		summaryBox(kind, x),
		el("div", { class: "actions" },
			kind === "pr" && !mine ? btn("a", "Approve", "approve") : null,
			kind === "pr" ? btn("m", "Merge", "merge", mine && ready(x) ? "primary" : "") : null,
			kind === "pr" && x.checks === "failure" ? btn("r", "Re-run failed", "rerun") : null,
			kind === "pr" ? btn("c", "Comment", "comment") : null,
			data[kind]?.summarize ? btn("s", "Summarize", "summarize") : null,
			btn("h", hidden ? "Unhide" : "Hide", "hide"),
			el("a", { class: "btn", href: x.url, target: "_blank", rel: "noopener" }, el("kbd", {}, "↵"), "Open")));
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
		el("a", { class: "title", href: x.url, target: "_blank", rel: "noopener", tabindex: "-1" }, x.title),
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
	main.append(el("div", { class: "foot" }, el("button", { class: "quiet", onclick: unlink }, "Disconnect GitHub")));
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
	setupPush();
	markSeen();
}

// SPEC 7: opening Nudgebox clears the unread count, on this icon and on the server
function markSeen() {
	navigator.clearAppBadge?.().catch(() => {});
	api("/api/push/seen", {}).catch(() => {});
}

async function unlink() {
	if (!confirm("Disconnect GitHub? The stored token is deleted.")) return;
	await api("/api/unlink", {});
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

// -- push (SPEC 7) ---------------------------------------------------------------
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function b64url(s) {
	const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

let pushReady = false;
async function setupPush() {
	if (pushReady || !("serviceWorker" in navigator)) return;
	pushReady = true;
	const btn = $("#push");
	const reg = await navigator.serviceWorker.register("/sw.js");
	if (!("PushManager" in window)) {
		if (isIOS && !standalone) {
			btn.hidden = false;
			btn.textContent = "Notifications?";
			btn.onclick = () => toast("On iPhone: Share → Add to Home Screen, then open Nudgebox from the Home Screen.");
		}
		return;
	}
	const current = await reg.pushManager.getSubscription();
	btn.hidden = false;
	btn.textContent = current ? "Notifications on" : "Turn on notifications";
	btn.onclick = async () => {
		const sub = await reg.pushManager.getSubscription();
		if (sub) {
			if (!confirm("Turn off notifications on this device?")) return;
			await api("/api/push/unsubscribe", { endpoint: sub.endpoint });
			await sub.unsubscribe();
			btn.textContent = "Turn on notifications";
			return;
		}
		if ((await Notification.requestPermission()) !== "granted") return toast("Notifications were not allowed");
		const { data: k } = await api("/api/push/key");
		const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(k.publicKey) });
		const { status } = await api("/api/push/subscribe", s.toJSON());
		btn.textContent = status === 201 ? "Notifications on" : "Turn on notifications";
		toast(status === 201 ? "Notifications are on for this device" : "Could not turn on notifications");
	};
}

$("#reload").onclick = load;
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
load();
$("#keys-btn").onclick = () => help().showModal();
