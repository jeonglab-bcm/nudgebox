// gh.bioinfolder.com front end. PRs: status tabs + repo filter over /api/inbox (SPEC 5);
// Issues: /api/issues (SPEC 11). Old and Hidden fold at the bottom. Push setup (SPEC 7).
// PR/issue text comes from GitHub and is untrusted: everything goes in via textContent.
const $ = (s) => document.querySelector(s);
// this script's own version (its ?v= hash); the server reports the current one
const VERSION = new URL(import.meta.url).searchParams.get("v");
const main = $("#main");

// view state; remembered per device (a convenience only, so failures are ignored)
const saved = (() => { try { return JSON.parse(localStorage.getItem("ghd-view") || "{}"); } catch { return {}; } })();
const view = { kind: saved.kind || "pr", tab: saved.tab || "needs_you", repo: saved.repo || "" };
const remember = () => { try { localStorage.setItem("ghd-view", JSON.stringify(view)); } catch {} };
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

const CHECKS = { success: ["checks passed", "ok"], failure: ["checks failed", "bad"], pending: ["checks running", "warn"], none: ["no checks", ""] };
const REVIEW = { APPROVED: ["approved", "ok"], CHANGES_REQUESTED: ["changes requested", "bad"], REVIEW_REQUIRED: ["review required", "warn"] };
const PR_TABS = [["needs_you", "Needs you"], ["waiting", "WIP"], ["ci_failing", "CI failing"], ["all", "All"]];
// mirrors readyToMerge in src/inbox.ts: only then is Merge the highlighted button
const ready = (pr) => !pr.draft && pr.mergeable !== "CONFLICTING" && ["success", "none"].includes(pr.checks) && [null, "APPROVED"].includes(pr.reviewDecision);
const byRepo = (xs) => (view.repo ? xs.filter((x) => x.repo === view.repo) : xs);
const busy = (fn) => async (e) => {
	e.target.disabled = true;
	try { await fn(); } finally { e.target.disabled = false; }
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
const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

function summaryBox(kind, item) {
	const s = summaries.get(`${kind}:${item.repo}#${item.number}`);
	if (!s) return null;
	const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
	return el("div", { class: "summary" }, el("ul", {}, lines.map((l) => el("li", {}, plain(l.replace(/^[-*•]\s*/, ""))))));
}

async function summarize(kind, item) {
	const { status, data: d } = await api("/api/summarize", { kind, repo: item.repo, number: item.number });
	if (status === 200) {
		summaries.set(`${kind}:${item.repo}#${item.number}`, d.summary);
		render();
	} else toast(d.error || `Summary failed (${status})`);
}

const summarizeButton = (kind, item) => (data[kind]?.summarize
	? el("button", { onclick: busy(async (e) => { e.target.textContent = "Summarizing…"; await summarize(kind, item); e.target.textContent = "Summarize"; }) }, "Summarize")
	: null);

function prRow(pr, opts = {}) {
	const mine = pr.author.toLowerCase() === data.login.toLowerCase();
	const [ct, cc] = CHECKS[pr.checks] || CHECKS.none;
	const rv = REVIEW[pr.reviewDecision];
	return el("div", { class: "pr" },
		el("div", { class: "top" }, el("a", { class: "title", href: pr.url, target: "_blank", rel: "noopener" }, pr.title)),
		el("div", { class: "meta" },
			el("span", {}, `${pr.repo.split("/")[1]}#${pr.number}`), "·", el("span", {}, pr.author), "·", el("span", {}, age(pr.updatedAt)),
			pr.draft ? el("span", { class: "chip" }, "draft") : null,
			rv ? el("span", { class: `chip ${rv[1]}` }, rv[0]) : null,
			el("span", { class: `chip ${cc}` }, ct),
			pr.mergeable === "CONFLICTING" ? el("span", { class: "chip bad" }, "conflicts") : null),
		summaryBox("pr", pr),
		el("div", { class: "actions" },
			!mine ? el("button", { onclick: busy(() => doAction(pr, "approve")) }, "Approve") : null,
			el("button", { class: mine && ready(pr) ? "primary" : "", onclick: busy(() => confirm(`Merge ${pr.repo}#${pr.number}?\n\n${pr.title}`) && doAction(pr, "merge", { confirm: true })) }, "Merge"),
			pr.checks === "failure" ? el("button", { onclick: busy(() => doAction(pr, "rerun")) }, "Re-run failed") : null,
			el("button", { onclick: busy(async () => { const b = prompt(`Comment on ${pr.repo}#${pr.number}`); if (b && b.trim()) await doAction(pr, "comment", { body: b }); }) }, "Comment"),
			summarizeButton("pr", pr),
			el("button", { onclick: busy(() => setHidden("pr", pr, !opts.hidden)) }, opts.hidden ? "Unhide" : "Hide")));
}

function issueRow(i, opts = {}) {
	return el("div", { class: "pr" },
		el("div", { class: "top" }, el("a", { class: "title", href: i.url, target: "_blank", rel: "noopener" }, i.title)),
		el("div", { class: "meta" },
			el("span", {}, `${i.repo.split("/")[1]}#${i.number}`), "·", el("span", {}, i.author), "·", el("span", {}, age(i.updatedAt)),
			i.comments ? el("span", { class: "chip" }, `${i.comments} comment${i.comments > 1 ? "s" : ""}`) : null,
			i.assignees.length ? el("span", { class: "chip" }, `→ ${i.assignees.join(", ")}`) : null,
			i.labels.map((l) => el("span", { class: "chip label" }, l))),
		summaryBox("issue", i),
		el("div", { class: "actions" }, summarizeButton("issue", i), el("button", { onclick: busy(() => setHidden("issue", i, !opts.hidden)) }, opts.hidden ? "Unhide" : "Hide")));
}

function fold(title, items, row) {
	if (!items.length) return null;
	return el("details", { class: "fold" }, el("summary", {}, `${title} (${items.length})`), items.map(row));
}

function render() {
	const kindData = data[view.kind];
	if (!kindData) return;
	for (const b of $("#kind").children) b.classList.toggle("on", b.dataset.k === view.kind);

	// repo filter: every repo with something in this view (live, old or hidden)
	const all = view.kind === "pr" ? [...kindData.sections.flatMap((s) => s.prs), ...kindData.old, ...kindData.hidden] : [...kindData.items, ...kindData.old, ...kindData.hidden];
	const repos = [...new Set(all.map((x) => x.repo))].sort((a, b) => a.split("/")[1].localeCompare(b.split("/")[1], undefined, { sensitivity: "base" }));
	if (view.repo && !repos.includes(view.repo)) view.repo = "";
	const sel = $("#repo");
	sel.replaceChildren(el("option", { value: "" }, "All repos"), ...repos.map((r) => el("option", { value: r, selected: r === view.repo }, r.split("/")[1])));

	const tabs = $("#tabs");
	main.replaceChildren();
	if (view.kind === "pr") {
		const live = Object.fromEntries(kindData.sections.map((s) => [s.id, byRepo(s.prs)]));
		live.all = byRepo(kindData.sections.flatMap((s) => s.prs)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		tabs.hidden = false;
		tabs.replaceChildren(...PR_TABS.map(([id, name]) =>
			el("button", { class: id === view.tab ? "on" : "", onclick: () => { view.tab = id; remember(); render(); } }, name, el("span", { class: "n" }, live[id].length))));
		const list = live[view.tab] || [];
		if (!list.length) main.append(el("p", { class: "empty" }, "Nothing here"));
		list.forEach((p) => main.append(prRow(p)));
		main.append(fold("Old: no activity for 30+ days", byRepo(kindData.old), (p) => prRow(p)) || "",
			fold("Hidden", byRepo(kindData.hidden), (p) => prRow(p, { hidden: true })) || "");
	} else {
		tabs.hidden = true;
		const list = byRepo(kindData.items);
		if (!list.length) main.append(el("p", { class: "empty" }, "No open issues"));
		list.forEach((i) => main.append(issueRow(i)));
		main.append(fold("Old: no activity for 30+ days", byRepo(kindData.old), (i) => issueRow(i)) || "",
			fold("Hidden", byRepo(kindData.hidden), (i) => issueRow(i, { hidden: true })) || "");
	}
	main.append(el("div", { class: "actions", style: "margin-top:24px" }, el("button", { onclick: unlink }, "Disconnect GitHub")));
}

async function load() {
	const [pr, issue] = await Promise.all([api("/api/inbox"), api("/api/issues")]);
	if (pr.status === 409 && pr.data.link) {
		$("nav").hidden = true;
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
	$("nav").hidden = false;
	data = { pr: pr.data, issue: issue.status === 200 ? issue.data : { items: [], old: [], hidden: [] }, login: pr.data.login };
	const seg = $("#kind").children;
	seg[0].textContent = `PRs ${pr.data.sections.reduce((n, s) => n + s.prs.length, 0)}`;
	seg[1].textContent = `Issues ${data.issue.items.length}`;
	render();
	setupPush();
}

async function unlink() {
	if (!confirm("Disconnect GitHub? The stored token is deleted.")) return;
	await api("/api/unlink", {});
	load();
}

$("#kind").addEventListener("click", (e) => {
	const k = e.target.closest("button")?.dataset.k;
	if (!k || k === view.kind) return;
	view.kind = k;
	remember();
	render();
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
