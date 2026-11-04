// Service worker: shows push notifications and opens the PR when one is tapped (SPEC 7).
self.addEventListener("push", (event) => {
	let data = { title: "Nudgebox", body: "", url: "/" };
	try {
		data = { ...data, ...event.data.json() };
	} catch {}
	// true when shown, else the reason it could not be
	const shown = self.registration.showNotification(data.title, { body: data.body, icon: "/icon-180.png", data: { url: data.url } })
		.then(() => true, (e) => e?.message || String(e));
	// SPEC 7: unread count on the app icon, where the browser supports it
	const badge = typeof data.badge === "number" && self.navigator?.setAppBadge ? self.navigator.setAppBadge(data.badge).catch(() => {}) : null;
	// SPEC 14: a Send a test push is reported to open Nudgebox pages, so they can say what happened
	const report = data.test ? shown.then(async (r) => {
		const msg = { type: "push-received", test: data.test, shown: r === true };
		if (r !== true) msg.error = r;
		for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage(msg);
	}) : null;
	event.waitUntil(Promise.all([shown, badge, report]));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
