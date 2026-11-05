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

function summaryBox(kind, item) {
	const s = summaries.get(`${kind}:${keyOf(item)}`);
	if (!s) return null;
	const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
	const bullet = (l) => l.replace(/^[-*•]\s*/, "");
	// SPEC 12: labelled rows (What, Key points, Status, Next); "- " lines under a label are its list
	const LABEL = /^(What|Key points|Status|Next):\s*(.*)$/i;
	if (LABEL.test(lines[0] ?? "")) {
		const rows = [];
		for (const l of lines) {
			const m = l.match(LABEL);
			if (m) rows.push({ label: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), text: m[2], items: [] });
			else if (/^[-*•]\s/.test(l)) rows.at(-1).items.push(bullet(l));
			else rows.at(-1).text += ` ${l}`;
		}
		return el("dl", { class: "summary" }, rows.flatMap((r) => [el("dt", {}, r.label),
			el("dd", {}, r.text ? el("p", {}, inline(r.text)) : null, r.items.length ? el("ul", {}, r.items.map((i) => el("li", {}, inline(i)))) : null)]));
	}
	// a summary kept in the older bullet form shows as a list
	return el("div", { class: "summary" }, el("ul", {}, lines.map((l) => el("li", {}, inline(bullet(l))))));
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
	const facts = kind === "pr"
		? [CHECKS[x.checks]?.[1], REVIEW[x.reviewDecision]?.[1], x.draft ? "draft" : null, x.mergeable === "CONFLICTING" ? "merge conflicts" : null, `updated ${age(x.updatedAt)} ago`]
		: [x.assignees.length ? `assigned to ${x.assignees.join(", ")}` : "unassigned", x.comments ? `${x.comments} comments` : null, ...x.labels, `updated ${age(x.updatedAt)} ago`];
	const btn = (key, label, name, cls = "") => el("button", { class: cls, onclick: busy(() => act(name, entry)) }, el("kbd", {}, key), label);
	return el("div", { class: "detail" },
		el("div", { class: "facts" }, facts.filter(Boolean).join(" · ")),
		summaryBox(kind, x),
		el("div", { class: "actions" },
			// SPEC 13: Approve, Merge, Comment and Open are keys only (fewer buttons)
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

async function refreshPush() {
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
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
				: "Notifications are blocked for this site. Allow gh.bioinfolder.com in your browser's site settings, and the browser in System Settings → Notifications." };
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

async function sendTest() {
	const { status, data: d } = await api("/api/push/test", { endpoint: push.sub.endpoint });
	toast(status === 200 ? "Test sent. It should arrive within a few seconds." : d.error || `Could not send (${status})`);
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

function renderSettings() {
	document.body.classList.add("settings");
	$("#tabs").hidden = true;
	const t = theme();
	const p = push;
	const stateText = { on: "On for this device.", off: "Off on this device.", blocked: p.reason, unavailable: `Not possible here. ${p.reason}` }[p.state];
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
				p.state === "on" ? el("button", { onclick: busy(turnOff) }, "Turn off") : null)),
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
			el("div", { class: "actions" }, el("button", { class: "danger", onclick: unlink }, "Disconnect GitHub")))));
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

window.addEventListener("hashchange", () => render());
$("#settings-btn").onclick = () => openSettings();
$("#bell").onclick = () => openSettings("notifications");
$("#reload").onclick = load;
$("#keys-btn").onclick = () => help().showModal();
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
load();
