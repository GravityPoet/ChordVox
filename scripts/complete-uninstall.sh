#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

APP_BUNDLES=(
  "/Applications/ChordVox.app"
  "$HOME/Applications/ChordVox.app"
)

APP_SUPPORT_TARGETS=(
  "$HOME/Library/Application Support/chordvox"
  "$HOME/Library/Application Support/ChordVox"
  "$HOME/Library/Application Support/ChordVox-development"
  "$HOME/Library/Application Support/ChordVox-staging"
)

CACHE_TARGETS=(
  "$HOME/Library/Caches/ChordVox"
  "$HOME/Library/Caches/chordvox"
)

PREFERENCE_TARGETS=(
  "$HOME/Library/Preferences/com.gravitypoet.chordvox.plist"
  "$HOME/Library/Preferences/com.gravitypoet.chordvox.helper.plist"
)

LOG_TARGETS=(
  "$HOME/Library/Logs/ChordVox"
  "$HOME/Library/Logs/chordvox"
)

SAVED_STATE_TARGETS=(
  "$HOME/Library/Saved Application State/com.gravitypoet.chordvox.savedState"
)

MODEL_TARGETS=(
  "$HOME/.cache/chordvox"
  "$HOME/.cache/whisper"
  "$HOME/Library/Application Support/whisper"
)

LOGIN_ITEMS=(
  "ChordVox"
)

remove_target() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target"
    rm -rf "$target" 2>/dev/null || sudo rm -rf "$target"
  fi
}

remove_targets() {
  local target
  for target in "$@"; do
    remove_target "$target"
  done
}

stop_named_processes() {
  local signal="$1"
  shift

  local process_name
  for process_name in "$@"; do
    pkill "-$signal" -x "$process_name" 2>/dev/null || true
  done
}

stop_matching_commands() {
  local signal="$1"
  local pid command line

  while IFS= read -r line; do
    pid="${line%% *}"
    command="${line#"$pid"}"
    command="${command# }"

    if [[ "$pid" == "$$" || "$pid" == "$PPID" ]]; then
      continue
    fi

    case "$command" in
      *"/Applications/ChordVox.app/"* | \
      *"$HOME/Applications/ChordVox.app/"* | \
      *"macos-globe-listener"* | \
      *"scripts/run-electron.js --dev"* | \
      *"node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"*"--app-path="* )
        kill "-$signal" "$pid" 2>/dev/null || true
        ;;
    esac
  done < <(ps ax -o pid= -o command=)
}

remove_login_items() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return
  fi

  local item_name
  for item_name in "${LOGIN_ITEMS[@]}"; do
    osascript \
      -e "tell application \"System Events\" to if exists login item \"$item_name\" then delete login item \"$item_name\"" \
      >/dev/null 2>&1 || true
  done
}

echo "This script will remove ChordVox app bundles, app data, caches, logs, login items, and preferences."
read -r -p "Continue with the full uninstall? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "Stopping running ChordVox processes..."
osascript -e 'tell application "ChordVox" to quit' >/dev/null 2>&1 || true

PROCESS_NAMES=(
  "ChordVox"
  "ChordVox Helper"
  "ChordVox Helper (Renderer)"
  "ChordVox Helper (GPU)"
  "ChordVox Helper (Plugin)"
  "macos-globe-listener"
)

stop_named_processes TERM "${PROCESS_NAMES[@]}"
stop_matching_commands TERM
sleep 1
stop_named_processes KILL "${PROCESS_NAMES[@]}"
stop_matching_commands KILL

echo "Removing login items..."
remove_login_items

echo "Removing installed app bundles (requires admin)..."
remove_targets "${APP_BUNDLES[@]}"

echo "Purging Application Support data (including development and staging paths)..."
remove_targets "${APP_SUPPORT_TARGETS[@]}"

echo "Removing caches, logs, saved state, and preferences..."
remove_targets "${CACHE_TARGETS[@]}"
remove_targets "${LOG_TARGETS[@]}"
remove_targets "${SAVED_STATE_TARGETS[@]}"
remove_targets "${PREFERENCE_TARGETS[@]}"

echo "Cleaning temporary files..."
shopt -s nullglob
for tmp in /tmp/chordvox* /tmp/whisper_audio_*; do
  remove_target "$tmp"
done
for crash in "$HOME/Library/Application Support/CrashReporter"/ChordVox_*; do
  remove_target "$crash"
done
shopt -u nullglob

read -r -p "Remove downloaded model caches (~/.cache/chordvox, ~/.cache/whisper, ~/Library/Application Support/whisper)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_targets "${MODEL_TARGETS[@]}"
fi

if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Remove the local environment file at $ENV_FILE? [y/N]: " wipe_env
  if [[ "$wipe_env" =~ ^[Yy]$ ]]; then
    echo "Removing $ENV_FILE"
    rm -f "$ENV_FILE"
  fi
fi

cat <<'EOF'
macOS keeps microphone, screen recording, and accessibility approvals even after files are removed.
Reset them if you want a truly fresh start:
  tccutil reset Microphone com.gravitypoet.chordvox
  tccutil reset Accessibility com.gravitypoet.chordvox
  tccutil reset ScreenCapture com.gravitypoet.chordvox

Full uninstall complete. Reboot if you reset permissions, then reinstall or run npm scripts on a clean tree.
EOF
