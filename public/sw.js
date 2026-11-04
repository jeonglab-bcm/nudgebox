// Service worker: shows push notifications and opens the PR when one is tapped (SPEC 7).
self.addEventListener("push", (event) => {
	let data = { title: "Nudgebox", body: "", url: "/" };
	try {
		data = { ...data, ...event.data.json() };
	} catch {}
	const shown = self.registration.showNotification(data.title, { body: data.body, icon: "/icon-180.png", data: { url: data.url } });
	// SPEC 7: unread count on the app icon, where the browser supports it
	const badge = typeof data.badge === "number" && self.navigator?.setAppBadge ? self.navigator.setAppBadge(data.badge).catch(() => {}) : null;
	event.waitUntil(Promise.all([shown, badge]));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
