fn main() {
	// The app's own commands, so capabilities/default.json can grant them to the page.
	tauri_build::try_build(
		tauri_build::Attributes::new()
			.app_manifest(tauri_build::AppManifest::new().commands(&["notify", "set_badge", "open_external"])),
	)
	.expect("failed to run tauri-build");
}
