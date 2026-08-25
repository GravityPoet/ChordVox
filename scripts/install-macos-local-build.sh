#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: the ChordVox local installer requires macOS." >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="ChordVox.app"
BUNDLE_ID="com.gravitypoet.chordvox"
INSTALL_APP="/Applications/$APP_NAME"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
PROCESS_PATTERN='^/Applications/ChordVox\.app/Contents/MacOS/ChordVox( |$)'
HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" == "x86_64" ]]; then
  PACKAGE_ARCH="x64"
else
  PACKAGE_ARCH="$HOST_ARCH"
fi
DEFAULT_SOURCE_APP="$ROOT_DIR/dist/.mac-dmg-work/mac-$PACKAGE_ARCH/$APP_NAME"
SOURCE_APP="${1:-$DEFAULT_SOURCE_APP}"
TEMP_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/chordvox-install.XXXXXX")"
# Keep hidden atomic-replacement paths recognizable as app bundles. @electron/fuses
# cannot resolve the same byte-identical Electron executable through a bundle path
# that omits the .app suffix.
INSTALL_STAGING="/Applications/.chordvox-staging-$$.app"
DISPLACED_APP="/Applications/.chordvox-displaced-$$.app"
BACKUP_ROOT="$HOME/Library/Application Support/Codex/Backups/ChordVox/AppRollbacks.noindex"
BACKUP_DIR="$BACKUP_ROOT/$(date '+%Y%m%d-%H%M%S')-$$"
BACKUP_ZIP="$BACKUP_DIR/$APP_NAME.zip"
OLD_REQUIREMENT=""
NEW_REQUIREMENT=""
HAD_PREVIOUS=0
REPLACEMENT_STARTED=0
ACCESSIBILITY_REGRANT_REQUIRED=0

safe_delete_tree() {
  local target="$1"
  case "$target" in
    "$INSTALL_APP"|"$INSTALL_STAGING"|"$DISPLACED_APP"|"$TEMP_ROOT"|"$DEFAULT_SOURCE_APP")
      if [[ -e "$target" ]]; then
        /usr/bin/find "$target" -depth -delete
      fi
      ;;
    *)
      echo "Refusing to delete unexpected path: $target" >&2
      return 1
      ;;
  esac
}

unregister_app_bundle() {
  local app_bundle="$1"
  if [[ -d "$app_bundle/Contents" ]]; then
    while IFS= read -r -d '' nested_app; do
      "$LSREGISTER" -u "$nested_app" >/dev/null 2>&1 || true
    done < <(/usr/bin/find "$app_bundle/Contents" -type d -name '*.app' -prune -print0 2>/dev/null)
  fi
  "$LSREGISTER" -u "$app_bundle" >/dev/null 2>&1 || true
}

designated_requirement() {
  /usr/bin/codesign -d -r- "$1" 2>&1 \
    | /usr/bin/sed -n 's/^# designated => //p; s/^designated => //p' \
    | /usr/bin/head -n 1
}

verify_app() {
  local app_bundle="$1"
  node "$ROOT_DIR/scripts/verify-mac-package.js" --platform mac "$app_bundle"
}

stop_installed_app() {
  /usr/bin/swift -e '
    import AppKit
    for item in NSRunningApplication.runningApplications(
      withBundleIdentifier: "com.gravitypoet.chordvox"
    ) {
      _ = item.terminate()
    }
  ' >/dev/null 2>&1 || true

  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    /usr/bin/pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1 || return 0
    /bin/sleep 1
  done
  /usr/bin/pkill -TERM -f "$PROCESS_PATTERN" >/dev/null 2>&1 || true
  /bin/sleep 1
  if /usr/bin/pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
    echo "Error: ChordVox did not quit cleanly." >&2
    return 1
  fi
}

start_installed_app() {
  /usr/bin/open -na "$INSTALL_APP"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if /usr/bin/pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 1
  done
  echo "Error: ChordVox did not start from /Applications." >&2
  return 1
}

restore_displaced_app() {
  [[ -d "$DISPLACED_APP" ]] || return 1
  [[ ! -e "$INSTALL_APP" ]] || return 1
  /bin/mv "$DISPLACED_APP" "$INSTALL_APP"
  "$LSREGISTER" -f "$INSTALL_APP" >/dev/null 2>&1 || true
  /usr/bin/open -na "$INSTALL_APP" >/dev/null 2>&1 || true
}

cleanup_or_rollback() {
  local exit_code=$?
  trap - EXIT INT TERM
  unregister_app_bundle "$INSTALL_STAGING"
  if [[ "$exit_code" -ne 0 && "$REPLACEMENT_STARTED" -eq 1 ]]; then
    stop_installed_app >/dev/null 2>&1 || true
    unregister_app_bundle "$INSTALL_APP"
    safe_delete_tree "$INSTALL_APP" >/dev/null 2>&1 || true
    if [[ "$HAD_PREVIOUS" -eq 1 ]] && restore_displaced_app; then
      echo "Restored the previous ChordVox installation after failure." >&2
    elif [[ "$HAD_PREVIOUS" -eq 1 ]]; then
      echo "Error: automatic rollback failed; restore $BACKUP_ZIP." >&2
    fi
  fi
  safe_delete_tree "$INSTALL_STAGING" >/dev/null 2>&1 || true
  safe_delete_tree "$TEMP_ROOT" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup_or_rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "Error: packaged ChordVox app not found: $SOURCE_APP" >&2
  exit 1
fi

verify_app "$SOURCE_APP"
NEW_REQUIREMENT="$(designated_requirement "$SOURCE_APP")"

if [[ -d "$INSTALL_APP" ]]; then
  HAD_PREVIOUS=1
  OLD_REQUIREMENT="$(designated_requirement "$INSTALL_APP" || true)"
  /bin/mkdir -p "$BACKUP_ROOT" "$BACKUP_DIR" "$TEMP_ROOT/backup-verification"
  /bin/chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"
  /usr/bin/touch "$BACKUP_ROOT/.metadata_never_index"
  /bin/chmod 600 "$BACKUP_ROOT/.metadata_never_index"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$INSTALL_APP" "$BACKUP_ZIP"
  /bin/chmod 600 "$BACKUP_ZIP"
  /usr/bin/unzip -tq "$BACKUP_ZIP" >/dev/null
  /usr/bin/ditto -x -k "$BACKUP_ZIP" "$TEMP_ROOT/backup-verification"
  /usr/bin/codesign --verify --deep --strict "$TEMP_ROOT/backup-verification/$APP_NAME"
fi

/usr/bin/ditto --norsrc --noextattr --noqtn "$SOURCE_APP" "$INSTALL_STAGING"
/usr/bin/xattr -cr "$INSTALL_STAGING"
verify_app "$INSTALL_STAGING"

stop_installed_app
REPLACEMENT_STARTED=1
if [[ "$HAD_PREVIOUS" -eq 1 ]]; then
  unregister_app_bundle "$INSTALL_APP"
  /bin/mv "$INSTALL_APP" "$DISPLACED_APP"
  unregister_app_bundle "$DISPLACED_APP"
fi
/bin/mv "$INSTALL_STAGING" "$INSTALL_APP"
/usr/bin/xattr -cr "$INSTALL_APP"
verify_app "$INSTALL_APP"
"$LSREGISTER" -f "$INSTALL_APP" >/dev/null 2>&1 || true
start_installed_app

if [[ -n "$OLD_REQUIREMENT" && "$OLD_REQUIREMENT" != "$NEW_REQUIREMENT" ]]; then
  ACCESSIBILITY_REGRANT_REQUIRED=1
  /usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' \
    >/dev/null 2>&1 || true
fi

if [[ "$SOURCE_APP" == "$DEFAULT_SOURCE_APP" ]]; then
  unregister_app_bundle "$SOURCE_APP"
  safe_delete_tree "$SOURCE_APP"
fi
unregister_app_bundle "$DISPLACED_APP"
safe_delete_tree "$DISPLACED_APP"
REPLACEMENT_STARTED=0
safe_delete_tree "$TEMP_ROOT"
trap - EXIT INT TERM

printf 'INSTALLED_APP=%s\n' "$INSTALL_APP"
printf 'DESIGNATED_REQUIREMENT=%s\n' "$NEW_REQUIREMENT"
printf 'ACCESSIBILITY_REGRANT_REQUIRED=%s\n' "$ACCESSIBILITY_REGRANT_REQUIRED"
if [[ "$HAD_PREVIOUS" -eq 1 ]]; then
  printf 'BACKUP_ZIP=%s\n' "$BACKUP_ZIP"
fi
