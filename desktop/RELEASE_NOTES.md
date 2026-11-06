Nudgebox (gh.bioinfolder.com) in its own window, with native notifications for review
requests, CI results, stale PRs and issues (SPEC 18). Sign in with your lab login once.
Closing the window keeps Nudgebox in the menu bar (Mac) or tray (Linux), so
notifications keep coming; use **Quit Nudgebox** there to stop it.

## Mac

1. Download **Nudgebox-mac-apple-silicon.dmg** (M1 or newer) or **Nudgebox-mac-intel.dmg**.
2. Open it and drag **Nudgebox** to **Applications**.
3. The app is not signed with an Apple Developer ID yet, so macOS blocks the first open.
   Run this once in Terminal, then open Nudgebox as usual:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Nudgebox.app
   ```
   (Or: open it once, then System Settings → Privacy & Security → **Open Anyway**.)
4. When the first notification comes, allow it. If none show, check System Settings →
   Notifications → **Nudgebox**, and Focus.

## Linux

- **AppImage:** `chmod +x Nudgebox-linux-x86_64.AppImage && ./Nudgebox-linux-x86_64.AppImage`
- **Debian/Ubuntu:** `sudo apt install ./nudgebox_amd64.deb`

The tray icon needs a desktop with tray support (on GNOME: the AppIndicator extension).

## Check it works

Settings (gear) → **Send a test**. It says whether the app received the test and whether
the system showed it.
