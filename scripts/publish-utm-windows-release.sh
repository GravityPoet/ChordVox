#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PINNED_WINDOWS_CERT="$REPO_ROOT/resources/windows/chordvox-local-code-signing.cer"

usage() {
  cat <<'EOF'
Usage:
  scripts/publish-utm-windows-release.sh <version> <source_sha> <real_dictation_verified_sha> <artifacts_dir> [release_repo]

Example:
  scripts/publish-utm-windows-release.sh \
    1.5.67 \
    0123456789abcdef0123456789abcdef01234567 \
    0123456789abcdef0123456789abcdef01234567 \
    /Users/me/Downloads/ChordVox-UTM/dist \
    GravityPoet/ChordVox

What it does:
  1. Requires WINDOWS_PUBLISHER_NAME and validates guest-generated Authenticode evidence
  2. Requires packaged fixed-WAV + trusted-click paste runtime evidence on the same source SHA
  3. Aligns installer and portable filenames in a temp staging dir
  4. Generates release-manifest-windows.json
  5. Uploads the binaries, metadata, and both evidence files to the GitHub release
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
REAL_DICTATION_VERIFIED_SHA="${3:-}"
ARTIFACTS_DIR="${4:-}"
RELEASE_REPO="${5:-${PUBLIC_RELEASE_REPO:-GravityPoet/ChordVox}}"
WINDOWS_PUBLISHER_NAME="${WINDOWS_PUBLISHER_NAME:-}"

if [ $# -lt 4 ] || [ $# -gt 5 ]; then
  usage
  exit 1
fi

validate_version "$VERSION" || fail "Invalid version: $VERSION"
validate_sha "$SOURCE_SHA" || fail "Invalid source SHA: $SOURCE_SHA"
validate_sha "$REAL_DICTATION_VERIFIED_SHA" || fail "Invalid real dictation verification SHA: $REAL_DICTATION_VERIFIED_SHA"
[ "$REAL_DICTATION_VERIFIED_SHA" = "$SOURCE_SHA" ] || fail "Real dictation release gate must pass on the same source SHA."
[ -d "$ARTIFACTS_DIR" ] || fail "Artifacts directory not found: $ARTIFACTS_DIR"
[ -n "$WINDOWS_PUBLISHER_NAME" ] || fail "WINDOWS_PUBLISHER_NAME is required and must match the Authenticode certificate common name."

require_cmd gh
require_cmd python3

gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not authenticated. Run: gh auth status"

TAG="v$VERSION"
LATEST_YML="$ARTIFACTS_DIR/latest.yml"
[ -f "$LATEST_YML" ] || fail "latest.yml not found in artifacts directory: $ARTIFACTS_DIR"
AUTHENTICODE_EVIDENCE="$ARTIFACTS_DIR/windows-authenticode-evidence.json"
NATIVE_RUNTIME_EVIDENCE="$ARTIFACTS_DIR/native-runtime-evidence-windows.json"
[ -f "$AUTHENTICODE_EVIDENCE" ] || fail "Missing guest-generated Authenticode evidence: $AUTHENTICODE_EVIDENCE"
[ -f "$NATIVE_RUNTIME_EVIDENCE" ] || fail "Missing guest-generated native runtime evidence: $NATIVE_RUNTIME_EVIDENCE"
[ -f "$PINNED_WINDOWS_CERT" ] || fail "Missing pinned Windows signing certificate: $PINNED_WINDOWS_CERT"

EXPECTED_INSTALLER_NAME="$(read_latest_yml_path "$LATEST_YML")" || fail "Could not read installer path from latest.yml"
EXPECTED_INSTALLER_NAME="$(basename "$EXPECTED_INSTALLER_NAME")"
[ -n "$EXPECTED_INSTALLER_NAME" ] || fail "latest.yml path is empty"
EXPECTED_BLOCKMAP_NAME="${EXPECTED_INSTALLER_NAME}.blockmap"

shopt -s nullglob
EXE_CANDIDATES=()
for file in "$ARTIFACTS_DIR"/*.exe; do
  base="$(basename "$file")"
  case "$base" in
    windows-fast-paste.exe|windows-key-listener.exe|nircmd.exe) continue ;;
  esac
  case "$base" in
    *"$VERSION"*) EXE_CANDIDATES+=("$file") ;;
  esac
done

BLOCKMAP_CANDIDATES=()
for file in "$ARTIFACTS_DIR"/*.blockmap; do
  base="$(basename "$file")"
  case "$base" in
    *"$VERSION"*) BLOCKMAP_CANDIDATES+=("$file") ;;
  esac
done

[ "${#EXE_CANDIDATES[@]}" -gt 0 ] || fail "No Windows release .exe found in $ARTIFACTS_DIR"
[ "${#BLOCKMAP_CANDIDATES[@]}" -gt 0 ] || fail "No Windows .blockmap found in $ARTIFACTS_DIR"

python3 - \
  "$VERSION" \
  "$SOURCE_SHA" \
  "$WINDOWS_PUBLISHER_NAME" \
  "$PINNED_WINDOWS_CERT" \
  "$AUTHENTICODE_EVIDENCE" \
  "$NATIVE_RUNTIME_EVIDENCE" \
  "${EXE_CANDIDATES[@]}" <<'PY'
import hashlib
import json
import os
import sys

version, source_sha, expected_publisher, pinned_cert_path, auth_path, runtime_path, *exe_paths = sys.argv[1:]

def fail(message):
    raise SystemExit(message)

def load_json(file_path):
    with open(file_path, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)

def sha256_file(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

if len(exe_paths) != 2:
    fail(f"Expected exactly two Windows release executables, found {len(exe_paths)}")

auth = load_json(auth_path)
if auth.get("schemaVersion") != 1:
    fail("Unsupported Authenticode evidence schema")
if auth.get("sourceSha") != source_sha:
    fail("Authenticode evidence source SHA mismatch")
if auth.get("version") != version:
    fail("Authenticode evidence version mismatch")
if auth.get("publisherName") != expected_publisher:
    fail("Authenticode evidence publisherName mismatch")
if not auth.get("signerThumbprint"):
    fail("Authenticode evidence signer thumbprint is missing")
if auth.get("certificateSha256") != sha256_file(pinned_cert_path):
    fail("Authenticode evidence does not match the pinned Windows signing certificate")

signed_by_hash = {}
for asset in auth.get("assets", []):
    digest = str(asset.get("sha256", "")).lower()
    if digest:
        signed_by_hash[digest] = asset

for exe_path in exe_paths:
    digest = sha256_file(exe_path)
    asset = signed_by_hash.get(digest)
    if not asset:
        fail(f"No matching Authenticode evidence for {os.path.basename(exe_path)}")
    if asset.get("status") != "Valid":
        fail(f"Invalid Authenticode status for {os.path.basename(exe_path)}")
    if asset.get("publisherName") != expected_publisher:
        fail(f"Publisher mismatch for {os.path.basename(exe_path)}")
    if asset.get("signerThumbprint") != auth.get("signerThumbprint"):
        fail(f"Signer mismatch for {os.path.basename(exe_path)}")
    if asset.get("timestamped") is not True:
        fail(f"Missing trusted timestamp for {os.path.basename(exe_path)}")

runtime = load_json(runtime_path)
required_runtime_values = {
    "schemaVersion": 1,
    "sourceSha": source_sha,
    "platform": "win32",
    "version": version,
    "appIsPackaged": True,
    "appPathUsesAsar": True,
    "userDataIsolated": True,
    "e2eHooksDisabled": True,
    "transcriptMatched": True,
    "trustedButtonClicks": True,
    "trustedPasteInput": True,
    "pasteTargetProcessDistinct": True,
}
for key, expected in required_runtime_values.items():
    if runtime.get(key) != expected:
        fail(f"Windows native runtime evidence mismatch for {key}")

if runtime.get("fixedWavSha256") != "28d8df884a775b226b41b7a43c45346cdd3333d30025eaf4ae6e20841cba39c6":
    fail("Windows native runtime evidence used an unexpected fixed WAV")
if runtime.get("whisperModelSha256") != "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21":
    fail("Windows native runtime evidence used an unexpected Whisper model")
PY

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chordvox-win-release.XXXXXX")"
EXPECTED_UPLOAD_NAMES=""
ACTUAL_RELEASE_NAMES=""
cleanup() {
  rm -rf "$STAGING_DIR"
  [ -z "$EXPECTED_UPLOAD_NAMES" ] || rm -f "$EXPECTED_UPLOAD_NAMES"
  [ -z "$ACTUAL_RELEASE_NAMES" ] || rm -f "$ACTUAL_RELEASE_NAMES"
}
trap cleanup EXIT

EXPECTED_INSTALLER_PATH="$STAGING_DIR/$EXPECTED_INSTALLER_NAME"
EXPECTED_BLOCKMAP_PATH="$STAGING_DIR/$EXPECTED_BLOCKMAP_NAME"
EXPECTED_PORTABLE_NAME="ChordVox-$VERSION.exe"
EXPECTED_PORTABLE_PATH="$STAGING_DIR/$EXPECTED_PORTABLE_NAME"
cp "$LATEST_YML" "$STAGING_DIR/latest.yml"
cp "$AUTHENTICODE_EVIDENCE" "$STAGING_DIR/windows-authenticode-evidence.json"
cp "$NATIVE_RUNTIME_EVIDENCE" "$STAGING_DIR/native-runtime-evidence-windows.json"

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

copy_matching_asset "$EXPECTED_INSTALLER_NAME" "$EXPECTED_INSTALLER_PATH" "${EXE_CANDIDATES[@]}"
copy_matching_asset "$EXPECTED_BLOCKMAP_NAME" "$EXPECTED_BLOCKMAP_PATH" "${BLOCKMAP_CANDIDATES[@]}"

PORTABLE_CANDIDATES=()
NORMALIZED_EXPECTED_INSTALLER_NAME="$(printf '%s' "$EXPECTED_INSTALLER_NAME" | tr ' ' '-')"
for file in "${EXE_CANDIDATES[@]}"; do
  base="$(basename "$file")"
  normalized_base="$(printf '%s' "$base" | tr ' ' '-')"
  if [ "$normalized_base" = "$NORMALIZED_EXPECTED_INSTALLER_NAME" ]; then
    continue
  fi
  PORTABLE_CANDIDATES+=("$file")
done

[ "${#PORTABLE_CANDIDATES[@]}" -gt 0 ] || fail "No portable Windows .exe found in $ARTIFACTS_DIR"
copy_matching_asset "$EXPECTED_PORTABLE_NAME" "$EXPECTED_PORTABLE_PATH" "${PORTABLE_CANDIDATES[@]}"

MANIFEST_PATH="$STAGING_DIR/release-manifest-windows.json"
python3 - "$TAG" "$VERSION" "$SOURCE_SHA" "$REAL_DICTATION_VERIFIED_SHA" "$STAGING_DIR" "$MANIFEST_PATH" <<'PY'
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

tag, version, source_sha, real_dictation_verified_sha, staging_dir, manifest_path = sys.argv[1:7]

def sha256_file(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

asset_names = sorted(
    name
    for name in os.listdir(staging_dir)
    if os.path.isfile(os.path.join(staging_dir, name))
    if name.endswith(".exe")
    or name.endswith(".blockmap")
    or name == "latest.yml"
    or name in {"windows-authenticode-evidence.json", "native-runtime-evidence-windows.json"}
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

with open(
    os.path.join(staging_dir, "windows-authenticode-evidence.json"),
    "r",
    encoding="utf-8-sig",
) as handle:
    authenticode = json.load(handle)
manifest = {
    "tag": tag,
    "version": version,
    "sourceSha": source_sha,
    "realDictationVerifiedSha": real_dictation_verified_sha,
    "platform": "windows-x64",
    "authenticode": {
        "publisherName": authenticode["publisherName"],
        "signerThumbprint": authenticode["signerThumbprint"],
        "evidenceSha256": sha256_file(os.path.join(staging_dir, "windows-authenticode-evidence.json")),
    },
    "nativeRuntimeEvidenceSha256": sha256_file(
        os.path.join(staging_dir, "native-runtime-evidence-windows.json")
    ),
    "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "assets": assets,
}

with open(manifest_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

gh release view "$TAG" -R "$RELEASE_REPO" >/dev/null 2>&1 || fail "Release not found: $RELEASE_REPO $TAG"

UPLOAD_ASSETS=(
  "$EXPECTED_PORTABLE_PATH"
  "$EXPECTED_INSTALLER_PATH"
  "$EXPECTED_BLOCKMAP_PATH"
  "$STAGING_DIR/latest.yml"
  "$STAGING_DIR/windows-authenticode-evidence.json"
  "$STAGING_DIR/native-runtime-evidence-windows.json"
  "$MANIFEST_PATH"
)

EXPECTED_UPLOAD_NAMES="$(mktemp)"
ACTUAL_RELEASE_NAMES="$(mktemp)"

printf '%s\n' "${UPLOAD_ASSETS[@]}" | xargs -n1 basename | sort -u > "$EXPECTED_UPLOAD_NAMES"
gh release view "$TAG" -R "$RELEASE_REPO" --json assets --jq '.assets[].name' \
  | sort -u > "$ACTUAL_RELEASE_NAMES"

# A manual retry must not leave an older Windows installer beside the verified
# one. Preserve macOS/Linux assets while removing only stale Windows entries.
while IFS= read -r asset_name; do
  case "$asset_name" in
    *.exe|*.exe.blockmap|latest.yml|release-manifest-windows.json|windows-authenticode-evidence.json|native-runtime-evidence-windows.json)
      if ! grep -Fqx -- "$asset_name" "$EXPECTED_UPLOAD_NAMES"; then
        log "Removing stale Windows release asset: $asset_name"
        gh release delete-asset "$TAG" "$asset_name" -R "$RELEASE_REPO" --yes
      fi
      ;;
  esac
done < "$ACTUAL_RELEASE_NAMES"

log "Uploading Windows assets to https://github.com/$RELEASE_REPO/releases/tag/$TAG"
gh release upload "$TAG" "${UPLOAD_ASSETS[@]}" -R "$RELEASE_REPO" --clobber

gh release view "$TAG" -R "$RELEASE_REPO" --json assets --jq '.assets[].name' \
  | sort -u > "$ACTUAL_RELEASE_NAMES"
MISSING_UPLOADS="$(comm -23 "$EXPECTED_UPLOAD_NAMES" "$ACTUAL_RELEASE_NAMES")"
[ -z "$MISSING_UPLOADS" ] || fail "Release is missing Windows assets: $MISSING_UPLOADS"

log "Validation:"
gh release view "$TAG" -R "$RELEASE_REPO" --json url,assets
log "Done"
