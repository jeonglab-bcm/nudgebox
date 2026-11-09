fn main() {
	// The app's own commands, so capabilities can grant them: the setup page gets
	// get_server and set_server (capabilities/default.json); the chosen server gets
	// the other three (added at start-up in main.rs).
	tauri_build::try_build(
		tauri_build::Attributes::new()
			.app_manifest(tauri_build::AppManifest::new().commands(&["notify", "set_badge", "open_external", "get_server", "set_server"])),
	)
	.expect("failed to run tauri-build");
}
