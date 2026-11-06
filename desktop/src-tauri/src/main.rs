//! Nudgebox desktop app (SPEC 18): gh.bioinfolder.com in its own window, with native
//! notifications. The page holds the server's live stream (/api/events) and calls the
//! commands below; closing the window keeps the app in the menu bar/tray.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{Menu, MenuItem};
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const HOME: &str = "https://gh.bioinfolder.com/";

/// Pages the window may show: Nudgebox and its sign-ins (Keycloak, and GitHub's for
/// linking an account). Everything else opens in the default browser.
fn stays_inside(u: &url::Url) -> bool {
	match (u.scheme(), u.host_str()) {
		("https", Some("gh.bioinfolder.com" | "auth.bioinfolder.com")) => true,
		("https", Some("github.com")) => u.path().starts_with("/login") || u.path().starts_with("/session"),
		("tauri" | "about" | "data" | "blob", _) => true,
		(_, Some("tauri.localhost")) => true,
		_ => false,
	}
}

/// In the page: links meant for a new tab (GitHub, CI details) open in the browser,
/// because a webview has no tabs.
const INIT: &str = r#"
(() => {
	if (location.host !== "gh.bioinfolder.com") return;
	const outside = (href) => {
		try {
			const u = new URL(href, location.href);
			return /^https?:$/.test(u.protocol) && u.origin !== location.origin;
		} catch { return false; }
	};
	const browse = (href) => window.__TAURI__.core.invoke("open_external", { url: new URL(href, location.href).href });
	const open = window.open;
	window.open = (href, target, features) => {
		if (href && (target === "_blank" || outside(href))) { browse(href); return null; }
		return open.call(window, href, target, features);
	};
	document.addEventListener("click", (e) => {
		const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
		if (!a || e.defaultPrevented || e.button !== 0) return;
		if (a.target === "_blank" || outside(a.href)) { e.preventDefault(); browse(a.href); }
	}, true);
})();
"#;

/// Shows one notification with the system's notifications.
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, url: Option<String>) -> Result<(), String> {
	let _ = url; // clicking a desktop notification brings Nudgebox forward; it cannot carry a link yet
	app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// The unread count on the Dock icon (Mac) or launcher (Linux, where supported); 0 clears it.
#[tauri::command]
fn set_badge(window: WebviewWindow, count: i64) {
	let _ = window.set_badge_count(if count > 0 { Some(count) } else { None });
}

/// Opens an http(s) link in the default browser.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
	let u = url::Url::parse(&url).map_err(|e| e.to_string())?;
	if !matches!(u.scheme(), "http" | "https") {
		return Err("only http and https links open".into());
	}
	app.opener().open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())
}

fn show(app: &AppHandle) {
	if let Some(w) = app.get_webview_window("main") {
		let _ = w.unminimize();
		let _ = w.show();
		let _ = w.set_focus();
	}
}

fn main() {
	let app = tauri::Builder::default()
		// first: a second launch shows the running app instead
		.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show(app)))
		.plugin(tauri_plugin_notification::init())
		.plugin(tauri_plugin_opener::init())
		.invoke_handler(tauri::generate_handler![notify, set_badge, open_external])
		.setup(|app| {
			let handle = app.handle().clone();
			WebviewWindowBuilder::new(app, "main", WebviewUrl::External(HOME.parse().expect("home url")))
				.title("Nudgebox")
				.inner_size(1280.0, 860.0)
				.min_inner_size(420.0, 500.0)
				.initialization_script(INIT)
				.on_navigation(move |u| {
					if stays_inside(u) {
						return true;
					}
					let _ = handle.opener().open_url(u.as_str(), None::<&str>);
					false
				})
				.build()?;

			let open = MenuItem::with_id(app, "show", "Open Nudgebox", true, None::<&str>)?;
			let quit = MenuItem::with_id(app, "quit", "Quit Nudgebox", true, Some("CmdOrCtrl+Q"))?;
			let menu = Menu::with_items(app, &[&open, &quit])?;
			if let Some(tray) = app.tray_by_id("main") {
				tray.set_menu(Some(menu))?;
				tray.on_menu_event(|app, e| match e.id().as_ref() {
					"show" => show(app),
					"quit" => app.exit(0),
					_ => {}
				});
			}
			Ok(())
		})
		// closing the window keeps the app (and its notifications) running
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { api, .. } = event {
				if window.label() == "main" {
					api.prevent_close();
					let _ = window.hide();
				}
			}
		})
		.build(tauri::generate_context!())
		.expect("error while building Nudgebox");

	app.run(|app, event| {
		// Mac: clicking the Dock icon (or a notification) with the window hidden
		#[cfg(target_os = "macos")]
		if let RunEvent::Reopen { .. } = event {
			show(app);
		}
		let _ = (app, event);
	});
}

#[cfg(test)]
mod tests {
	use super::stays_inside;

	fn inside(s: &str) -> bool {
		stays_inside(&s.parse().unwrap())
	}

	#[test]
	fn nudgebox_and_its_sign_ins_stay_in_the_window() {
		assert!(inside("https://gh.bioinfolder.com/#settings"));
		assert!(inside("https://auth.bioinfolder.com/realms/bioinfolder/protocol/openid-connect/auth?x=1"));
		assert!(inside("https://github.com/login/oauth/authorize?client_id=x"));
		assert!(inside("https://github.com/sessions/two-factor"));
	}

	#[test]
	fn everything_else_opens_in_the_browser() {
		assert!(!inside("https://github.com/jeonglab-bcm/nudgebox/pull/28"));
		assert!(!inside("http://gh.bioinfolder.com/"));
		assert!(!inside("https://gh.bioinfolder.com.evil.example/"));
		assert!(!inside("https://example.com/"));
	}
}
