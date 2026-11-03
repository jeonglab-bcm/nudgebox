// gh.bioinfolder.com front end: renders /api/inbox, runs the four actions, manages push.
// PR text comes from GitHub and is untrusted: everything goes in via textContent.
const $ = (s) => document.querySelector(s);
const main = $("#main");

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
	const data = await r.json().catch(() => ({}));
	return { status: r.status, data };
}

function age(iso) {
	const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
	if (m < 60) return `${Math.round(m)}m`;
	if (m < 1440) return `${Math.round(m / 60)}h`;
	return `${Math.round(m / 1440)}d`;
}

const CHECKS = { success: ["checks passed", "ok"], failure: ["checks failed", "bad"], pending: ["checks running", "warn"], none: ["no checks", ""] };
const REVIEW = { APPROVED: ["approved", "ok"], CHANGES_REQUESTED: ["changes requested", "bad"], REVIEW_REQUIRED: ["review required", "warn"] };

// mirrors readyToMerge in src/inbox.ts: only then is Merge the highlighted button
const ready = (pr) => !pr.draft && pr.mergeable !== "CONFLICTING" && ["success", "none"].includes(pr.checks) && [null, "APPROVED"].includes(pr.reviewDecision);

async function doAction(pr, action, extra = {}) {
	const { status, data } = await api(`/api/prs/${action}`, { repo: pr.repo, number: pr.number, ...extra });
	if (status === 200) {
		toast({ merge: "Merged", approve: "Approved", rerun: "Re-running failed checks", comment: "Comment posted" }[action]);
		setTimeout(load, 1500);
	} else toast(data.error || `Failed (${status})`);
}

function row(pr, me) {
	const mine = pr.author.toLowerCase() === me.toLowerCase();
	const [ct, cc] = CHECKS[pr.checks] || CHECKS.none;
	const rv = REVIEW[pr.reviewDecision];
	const busy = (fn) => async (e) => {
		e.target.disabled = true;
		try { await fn(); } finally { e.target.disabled = false; }
	};
	return el("div", { class: "pr" },
		el("div", { class: "top" }, el("a", { class: "title", href: pr.url, target: "_blank", rel: "noopener" }, pr.title)),
		el("div", { class: "meta" },
			el("span", {}, `${pr.repo.split("/")[1]}#${pr.number}`), "·", el("span", {}, pr.author), "·", el("span", {}, age(pr.updatedAt)),
			pr.draft ? el("span", { class: "chip" }, "draft") : null,
			rv ? el("span", { class: `chip ${rv[1]}` }, rv[0]) : null,
			el("span", { class: `chip ${cc}` }, ct),
			pr.mergeable === "CONFLICTING" ? el("span", { class: "chip bad" }, "conflicts") : null),
		el("div", { class: "actions" },
			!mine ? el("button", { onclick: busy(() => doAction(pr, "approve")) }, "Approve") : null,
			el("button", { class: mine && ready(pr) ? "primary" : "", onclick: busy(() => confirm(`Merge ${pr.repo}#${pr.number}?\n\n${pr.title}`) && doAction(pr, "merge", { confirm: true })) }, "Merge"),
			pr.checks === "failure" ? el("button", { onclick: busy(() => doAction(pr, "rerun")) }, "Re-run failed") : null,
			el("button", { onclick: busy(async () => { const b = prompt(`Comment on ${pr.repo}#${pr.number}`); if (b && b.trim()) await doAction(pr, "comment", { body: b }); }) }, "Comment")));
}

async function load() {
	const { status, data } = await api("/api/inbox");
	main.replaceChildren();
	if (status === 409 && data.link) {
		main.append(el("div", { class: "notice" },
			el("p", {}, "Connect your GitHub account once so the inbox can show the PRs you can see, and so actions run as you."),
			el("a", { class: "btn primary", href: data.link }, "Connect GitHub")));
		return;
	}
	if (status !== 200) {
		main.append(el("p", { class: "empty" }, data.error || `Could not load (${status})`));
		return;
	}
	for (const s of data.sections) {
		main.append(el("h2", {}, s.title, el("span", { class: "n" }, s.prs.length)));
		if (!s.prs.length) main.append(el("div", { class: "empty" }, "Nothing here"));
		for (const pr of s.prs) main.append(row(pr, data.login));
	}
	main.append(el("div", { class: "actions" }, el("button", { onclick: unlink }, "Disconnect GitHub")));
	setupPush();
}

async function unlink() {
	if (!confirm("Disconnect GitHub? The stored token is deleted.")) return;
	await api("/api/unlink", {});
	load();
}

// -- push (SPEC 7) ---------------------------------------------------------------
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function b64url(s) {
	const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function setupPush() {
	const btn = $("#push");
	if (!("serviceWorker" in navigator)) return;
	const reg = await navigator.serviceWorker.register("/sw.js");
	if (!("PushManager" in window)) {
		if (isIOS && !standalone) {
			btn.hidden = false;
			btn.textContent = "Notifications?";
			btn.onclick = () => toast("On iPhone: Share → Add to Home Screen, then open Lab PRs from the Home Screen.");
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
		const { data } = await api("/api/push/key");
		const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(data.publicKey) });
		const { status } = await api("/api/push/subscribe", s.toJSON());
		btn.textContent = status === 201 ? "Notifications on" : "Turn on notifications";
		toast(status === 201 ? "Notifications are on for this device" : "Could not turn on notifications");
	};
}

$("#reload").onclick = load;
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && load());
load();
