#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/publish-utm-windows-release.sh <version> <source_sha> <artifacts_dir> [release_repo]

Example:
  scripts/publish-utm-windows-release.sh \
    1.5.67 \
    0123456789abcdef0123456789abcdef01234567 \
    /Users/me/Downloads/ChordVox-UTM/dist \
    GravityPoet/ChordVox

What it does:
  1. Validates a UTM-built Windows dist directory
  2. Aligns installer filenames to latest.yml in a temp staging dir
  3. Generates release-manifest-windows.json
  4. Uploads the installer, blockmap, latest.yml, and manifest to the GitHub release
EOF
}

log() {
  printf '[publish-utm-windows-release] %s\n' "$*"
}

fail() {
  printf '[publish-utm-windows-release] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

validate_version() {
  case "$1" in
    '' ) return 1 ;;
    *[!0-9A-Za-z.-]* ) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$'
}

validate_sha() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'
}

read_latest_yml_path() {
  python3 - "$1" <<'PY'
import sys

latest_yml = sys.argv[1]
with open(latest_yml, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.strip()
        if not line.startswith("path:"):
            continue
        value = line.split(":", 1)[1].strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        if value:
            print(value)
            raise SystemExit(0)
raise SystemExit(1)
PY
}

VERSION="${1:-}"
SOURCE_SHA="${2:-}"
ARTIFACTS_DIR="${3:-}"
RELEASE_REPO="${4:-${PUBLIC_RELEASE_REPO:-GravityPoet/ChordVox}}"

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  usage
  exit 1
fi

validate_version "$VERSION" || fail "Invalid version: $VERSION"
validate_sha "$SOURCE_SHA" || fail "Invalid source SHA: $SOURCE_SHA"
[ -d "$ARTIFACTS_DIR" ] || fail "Artifacts directory not found: $ARTIFACTS_DIR"

require_cmd gh
require_cmd python3

gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not authenticated. Run: gh auth status"

TAG="v$VERSION"
LATEST_YML="$ARTIFACTS_DIR/latest.yml"
[ -f "$LATEST_YML" ] || fail "latest.yml not found in artifacts directory: $ARTIFACTS_DIR"

EXPECTED_INSTALLER_NAME="$(read_latest_yml_path "$LATEST_YML")" || fail "Could not read installer path from latest.yml"
EXPECTED_INSTALLER_NAME="$(basename "$EXPECTED_INSTALLER_NAME")"
[ -n "$EXPECTED_INSTALLER_NAME" ] || fail "latest.yml path is empty"
EXPECTED_BLOCKMAP_NAME="${EXPECTED_INSTALLER_NAME}.blockmap"

shopt -s nullglob
INSTALLER_CANDIDATES=()
for file in "$ARTIFACTS_DIR"/*.exe; do
  base="$(basename "$file")"
  case "$base" in
    *Portable*|*portable*) continue ;;
    windows-fast-paste.exe|windows-key-listener.exe|nircmd.exe) continue ;;
  esac
  case "$base" in
    *"$VERSION"*) INSTALLER_CANDIDATES+=("$file") ;;
  esac
done

BLOCKMAP_CANDIDATES=()
for file in "$ARTIFACTS_DIR"/*.blockmap; do
  base="$(basename "$file")"
  case "$base" in
    *"$VERSION"*) BLOCKMAP_CANDIDATES+=("$file") ;;
  esac
done

[ "${#INSTALLER_CANDIDATES[@]}" -gt 0 ] || fail "No Windows installer .exe found in $ARTIFACTS_DIR"
[ "${#BLOCKMAP_CANDIDATES[@]}" -gt 0 ] || fail "No Windows .blockmap found in $ARTIFACTS_DIR"

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chordvox-win-release.XXXXXX")"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

EXPECTED_INSTALLER_PATH="$STAGING_DIR/$EXPECTED_INSTALLER_NAME"
EXPECTED_BLOCKMAP_PATH="$STAGING_DIR/$EXPECTED_BLOCKMAP_NAME"
cp "$LATEST_YML" "$STAGING_DIR/latest.yml"

copy_matching_asset() {
  local expected_name="$1"
  local dest_path="$2"
  shift 2
  local expected_source=""
  local alternate_source=""
  local candidates=("$@")
  local file
  local base
  local normalized_base
  local normalized_expected

  for file in "${candidates[@]}"; do
    base="$(basename "$file")"
    if [ "$base" = "$expected_name" ]; then
      expected_source="$file"
      break
    fi
  done

  if [ -n "$expected_source" ]; then
    cp "$expected_source" "$dest_path"
    return 0
  fi

  for file in "${candidates[@]}"; do
    base="$(basename "$file")"
    normalized_base="$(printf '%s' "$base" | tr ' ' '-')"
    normalized_expected="$(printf '%s' "$expected_name" | tr ' ' '-')"
    if [ "$normalized_base" = "$normalized_expected" ]; then
      alternate_source="$file"
      break
    fi
  done

  if [ -n "$alternate_source" ]; then
    cp "$alternate_source" "$dest_path"
    return 0
  fi

  if [ "${#candidates[@]}" -eq 1 ]; then
    cp "${candidates[0]}" "$dest_path"
    return 0
  fi

  fail "Could not uniquely match asset for $expected_name"
}

copy_matching_asset "$EXPECTED_INSTALLER_NAME" "$EXPECTED_INSTALLER_PATH" "${INSTALLER_CANDIDATES[@]}"
copy_matching_asset "$EXPECTED_BLOCKMAP_NAME" "$EXPECTED_BLOCKMAP_PATH" "${BLOCKMAP_CANDIDATES[@]}"

MANIFEST_PATH="$STAGING_DIR/release-manifest-windows.json"
python3 - "$TAG" "$VERSION" "$SOURCE_SHA" "$STAGING_DIR" "$MANIFEST_PATH" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

tag, version, source_sha, staging_dir, manifest_path = sys.argv[1:6]
asset_names = sorted(
    name
    for name in os.listdir(staging_dir)
    if os.path.isfile(os.path.join(staging_dir, name))
    if name.endswith(".exe") or name.endswith(".blockmap") or name == "latest.yml"
)

assets = []
for name in asset_names:
    full_path = os.path.join(staging_dir, name)
    digest = hashlib.sha256()
    with open(full_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    assets.append(
        {
            "name": name,
            "sha256": digest.hexdigest(),
            "sizeBytes": os.path.getsize(full_path),
        }
    )

manifest = {
    "tag": tag,
    "version": version,
    "sourceSha": source_sha,
    "platform": "windows-x64",
    "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "assets": assets,
}

with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

gh release view "$TAG" -R "$RELEASE_REPO" >/dev/null 2>&1 || fail "Release not found: $RELEASE_REPO $TAG"

UPLOAD_ASSETS=(
  "$EXPECTED_INSTALLER_PATH"
  "$EXPECTED_BLOCKMAP_PATH"
  "$STAGING_DIR/latest.yml"
  "$MANIFEST_PATH"
)

log "Uploading Windows assets to https://github.com/$RELEASE_REPO/releases/tag/$TAG"
gh release upload "$TAG" "${UPLOAD_ASSETS[@]}" -R "$RELEASE_REPO" --clobber

log "Validation:"
gh release view "$TAG" -R "$RELEASE_REPO" --json url,assets
log "Done"
