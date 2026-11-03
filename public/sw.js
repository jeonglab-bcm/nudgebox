// Service worker: shows push notifications and opens the PR when one is tapped (SPEC 7).
self.addEventListener("push", (event) => {
	let data = { title: "Lab PRs", body: "", url: "/" };
	try {
		data = { ...data, ...event.data.json() };
	} catch {}
	event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: "/icon-180.png", data: { url: data.url } }));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
