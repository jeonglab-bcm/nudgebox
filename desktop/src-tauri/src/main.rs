//! Nudgebox desktop app (SPEC 18): a Nudgebox site in its own window, with native
//! notifications. The page holds the server's live stream (/api/events) and calls the
//! commands below; closing the window keeps the app in the menu bar/tray.
//!
//! Which site: asked on first launch (default gh.bioinfolder.com) and kept in the app's
//! config folder; "Change server…" in the tray asks again (issue #33). Only that site
//! may call the app's commands: its capability is added when the app starts.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem};
#[cfg(target_os = "macos")]
use tauri::RunEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const DEFAULT_SERVER: &str = "https://gh.bioinfolder.com/";

/// What the person typed, as a server's home address: https only, no path, no login.
fn server_address(typed: &str) -> Result<Url, String> {
	let t = typed.trim();
	if t.is_empty() {
		return Err("Type your Nudgebox address, e.g. review.example.org".into());
	}
	let full = if t.contains("://") { t.to_string() } else { format!("https://{t}") };
	let u = Url::parse(&full).map_err(|_| format!("\"{t}\" is not a web address"))?;
	if u.scheme() != "https" {
		return Err("Only https addresses: Nudgebox needs a secure site".into());
	}
	if !u.username().is_empty() || u.password().is_some() {
		return Err("Leave the user name and password out of the address".into());
	}
	let host = u.host_str().ok_or("The address has no site name")?;
	let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
	Url::parse(&format!("https://{host}{port}/")).map_err(|e| e.to_string())
}

/// The chosen site, or one of its siblings (its sign-in, e.g. auth.bioinfolder.com next
/// to gh.bioinfolder.com). A two-label site (example.org) has no siblings.
fn same_site(host: &str, server: &Url) -> bool {
	let Some(s) = server.host_str() else { return false };
	if host == s {
		return true;
	}
	match s.split_once('.') {
		Some((_, parent)) if parent.contains('.') && server.host().is_some_and(|h| matches!(h, url::Host::Domain(_))) => host.ends_with(&format!(".{parent}")),
		_ => false,
	}
}

/// Pages the window may show: the chosen Nudgebox and its sign-ins (its own, and GitHub's
/// for linking an account). Everything else opens in the default browser.
fn stays_inside(u: &Url, server: &Url) -> bool {
	match (u.scheme(), u.host_str()) {
		("https", Some("github.com")) => u.path().starts_with("/login") || u.path().starts_with("/session"),
		("https", Some(h)) => same_site(h, server),
		("tauri" | "about" | "data" | "blob", _) => true,
		(_, Some("tauri.localhost")) => true,
		_ => false,
	}
}

/// In the page: links meant for a new tab (GitHub, CI details) open in the browser,
/// because a webview has no tabs.
fn init_script(server: &Url) -> String {
	let host = server.host_str().unwrap_or_default();
	let port = server.port().map(|p| format!(":{p}")).unwrap_or_default();
	INIT.replace("__HOST__", &format!("{:?}", format!("{host}{port}")))
}

const INIT: &str = r#"
(() => {
	if (location.host !== __HOST__) return;
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

fn server_file(app: &AppHandle) -> Option<PathBuf> {
	app.path().app_config_dir().ok().map(|d| d.join("server.txt"))
}

/// The server chosen before, if any.
fn saved_server(app: &AppHandle) -> Option<Url> {
	let text = std::fs::read_to_string(server_file(app)?).ok()?;
	server_address(&text).ok()
}

/// For the setup page: the address to show in the box.
#[tauri::command]
fn get_server(app: AppHandle) -> String {
	saved_server(&app).map(|u| u.to_string()).unwrap_or_else(|| DEFAULT_SERVER.into())
}

/// From the setup page: keeps the address and restarts the app on it.
#[tauri::command]
fn set_server(app: AppHandle, address: String) -> Result<(), String> {
	let u = server_address(&address)?;
	let file = server_file(&app).ok_or("no folder to keep the setting in")?;
	if let Some(dir) = file.parent() {
		std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
	}
	std::fs::write(&file, u.as_str()).map_err(|e| e.to_string())?;
	app.restart();
}

/// The small window that asks for the server's address (dist/index.html).
fn ask_server(app: &AppHandle) -> tauri::Result<()> {
	if let Some(w) = app.get_webview_window("setup") {
		let _ = w.show();
		return w.set_focus();
	}
	WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
		.title("Nudgebox server")
		.inner_size(480.0, 340.0)
		.resizable(false)
		.build()?;
	Ok(())
}

/// The main window on the chosen server, which alone may call the app's commands.
fn open_server(app: &AppHandle, server: Url) -> tauri::Result<()> {
	app.add_capability(
		CapabilityBuilder::new("server")
			.remote(format!("{}*", server.as_str()))
			.local(false)
			.window("main")
			.permission("allow-notify")
			.permission("allow-set-badge")
			.permission("allow-open-external"),
	)?;
	let handle = app.clone();
	let home = server.clone();
	WebviewWindowBuilder::new(app, "main", WebviewUrl::External(server.clone()))
		.title("Nudgebox")
		.inner_size(1280.0, 860.0)
		.min_inner_size(420.0, 500.0)
		.initialization_script(init_script(&server))
		.on_navigation(move |u| {
			if stays_inside(u, &home) {
				return true;
			}
			let _ = handle.opener().open_url(u.as_str(), None::<&str>);
			false
		})
		.build()?;
	Ok(())
}

fn show(app: &AppHandle) {
	// before a server is chosen there is only the setup window
	if let Some(w) = app.get_webview_window("main").or_else(|| app.get_webview_window("setup")) {
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
		.invoke_handler(tauri::generate_handler![notify, set_badge, open_external, get_server, set_server])
		.setup(|app| {
			match saved_server(app.handle()) {
				Some(server) => open_server(app.handle(), server)?,
				None => ask_server(app.handle())?, // first launch
			}

			let open = MenuItem::with_id(app, "show", "Open Nudgebox", true, None::<&str>)?;
			let server = MenuItem::with_id(app, "server", "Change server…", true, None::<&str>)?;
			let quit = MenuItem::with_id(app, "quit", "Quit Nudgebox", true, Some("CmdOrCtrl+Q"))?;
			let menu = Menu::with_items(app, &[&open, &server, &quit])?;
			if let Some(tray) = app.tray_by_id("main") {
				tray.set_menu(Some(menu))?;
				tray.on_menu_event(|app, e| match e.id().as_ref() {
					"show" => show(app),
					"server" => {
						let _ = ask_server(app);
					}
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
	use super::{init_script, server_address, stays_inside};

	fn inside(s: &str, server: &str) -> bool {
		stays_inside(&s.parse().unwrap(), &server.parse().unwrap())
	}

	const LAB: &str = "https://gh.bioinfolder.com/";
	const OTHER: &str = "https://review.example.org/";

	#[test]
	fn nudgebox_and_its_sign_ins_stay_in_the_window() {
		assert!(inside("https://gh.bioinfolder.com/#settings", LAB));
		assert!(inside("https://auth.bioinfolder.com/realms/bioinfolder/protocol/openid-connect/auth?x=1", LAB));
		assert!(inside("https://github.com/login/oauth/authorize?client_id=x", LAB));
		assert!(inside("https://github.com/sessions/two-factor", LAB));
	}

	#[test]
	fn everything_else_opens_in_the_browser() {
		assert!(!inside("https://github.com/jeonglab-bcm/nudgebox/pull/28", LAB));
		assert!(!inside("http://gh.bioinfolder.com/", LAB));
		assert!(!inside("https://gh.bioinfolder.com.evil.example/", LAB));
		assert!(!inside("https://example.com/", LAB));
	}

	#[test]
	fn another_labs_server_and_its_sign_in_stay_in_the_window() {
		assert!(inside("https://review.example.org/#pr/x/y/1", OTHER));
		assert!(inside("https://login.example.org/oauth2/start", OTHER));
		assert!(inside("https://github.com/login/oauth/authorize?client_id=x", OTHER));
		assert!(!inside("https://gh.bioinfolder.com/", OTHER), "only the chosen server");
		assert!(!inside("https://review.example.org.evil.example/", OTHER));
		assert!(!inside("https://evilexample.org/", OTHER));
		assert!(!inside("http://review.example.org/", OTHER));
		// a two-label host has no siblings: example.org does not let in every *.org
		assert!(inside("https://example.org/", "https://example.org/"));
		assert!(!inside("https://other.org/", "https://example.org/"));
	}

	#[test]
	fn a_typed_address_is_cleaned_up_and_only_https_is_taken() {
		let ok = |s: &str| server_address(s).map(|u| u.to_string());
		assert_eq!(ok("otherlab.org").unwrap(), "https://otherlab.org/");
		assert_eq!(ok("  https://Review.Example.org/some/page?x=1#y ").unwrap(), "https://review.example.org/");
		assert_eq!(ok("review.example.org:8443").unwrap(), "https://review.example.org:8443/");
		assert!(ok("http://otherlab.org").is_err());
		assert!(ok("ftp://otherlab.org").is_err());
		assert!(ok("").is_err());
		assert!(ok("https://user:pw@otherlab.org/").is_err());
	}

	#[test]
	fn the_page_script_only_acts_on_the_chosen_server() {
		let s = init_script(&OTHER.parse().unwrap());
		assert!(s.contains(r#"location.host !== "review.example.org""#), "{s}");
	}
}
