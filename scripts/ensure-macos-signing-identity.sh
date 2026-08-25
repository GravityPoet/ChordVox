#!/bin/bash
set -euo pipefail

IDENTITY="ChordVox Local Code Signing"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINNED_CERTIFICATE="$ROOT_DIR/resources/mac/chordvox-local-signing.crt"
KEYCHAIN="${CHORDVOX_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
BACKUP_DIR="$HOME/Library/Application Support/Codex/Backups/ChordVox/Signing.noindex"
P12_BACKUP="$BACKUP_DIR/ChordVox-Local-Code-Signing.p12"
CERTIFICATE_BACKUP="$BACKUP_DIR/ChordVox-Local-Code-Signing.pem"
PASSWORD_SERVICE="com.gravitypoet.chordvox.local-signing-backup"
PASSWORD_ACCOUNT="$IDENTITY"
BOOTSTRAP=0
CREATED_IDENTITY=0
CREATED_TRUST=0
CREATED_PASSWORD=0
CREATED_BACKUP=0
CREATED_PINNED_CERTIFICATE=0
TRUSTED_CERTIFICATE=""

if [[ "${1:-}" == "--bootstrap" ]]; then
  BOOTSTRAP=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--bootstrap]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: ChordVox macOS signing setup requires macOS." >&2
  exit 2
fi

if [[ -x /opt/homebrew/bin/openssl ]]; then
  OPENSSL=/opt/homebrew/bin/openssl
elif [[ -x /usr/local/bin/openssl ]]; then
  OPENSSL=/usr/local/bin/openssl
elif [[ -x /usr/bin/openssl ]]; then
  OPENSSL=/usr/bin/openssl
else
  echo "Error: OpenSSL is required to inspect the ChordVox signing certificate." >&2
  exit 2
fi

identity_exists() {
  /usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null \
    | /usr/bin/grep -F "\"$IDENTITY\"" >/dev/null
}

certificate_fingerprint_sha256() {
  "$OPENSSL" x509 -in "$1" -noout -fingerprint -sha256 \
    | /usr/bin/sed 's/^[^=]*=//; s/://g' \
    | /usr/bin/tr '[:lower:]' '[:upper:]'
}

keychain_certificate_fingerprint_sha256() {
  /usr/bin/security find-certificate -c "$IDENTITY" -p "$KEYCHAIN" \
    | "$OPENSSL" x509 -noout -fingerprint -sha256 \
    | /usr/bin/sed 's/^[^=]*=//; s/://g' \
    | /usr/bin/tr '[:lower:]' '[:upper:]'
}

verify_pinned_identity() {
  if [[ ! -f "$PINNED_CERTIFICATE" ]]; then
    if [[ "$BOOTSTRAP" -eq 1 ]]; then
      return 0
    fi
    echo "Error: pinned ChordVox public signing certificate is missing." >&2
    return 1
  fi

  local expected_fingerprint
  local actual_fingerprint
  expected_fingerprint="$(certificate_fingerprint_sha256 "$PINNED_CERTIFICATE")"
  actual_fingerprint="$(keychain_certificate_fingerprint_sha256)"
  if [[ -z "$expected_fingerprint" || "$actual_fingerprint" != "$expected_fingerprint" ]]; then
    echo "Error: the keychain identity does not match the pinned ChordVox certificate." >&2
    return 1
  fi

  "$OPENSSL" x509 -in "$PINNED_CERTIFICATE" -checkend 2592000 -noout >/dev/null || {
    echo "Error: the ChordVox signing certificate expires within 30 days." >&2
    return 1
  }
}

WORK_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/chordvox-codesign.XXXXXX")"

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if [[ "$status" -ne 0 ]]; then
    if [[ "$BOOTSTRAP" -eq 1 ]]; then
      if [[ "$CREATED_BACKUP" -eq 1 && -d "$BACKUP_DIR" ]]; then
        /usr/bin/find "$BACKUP_DIR" -maxdepth 1 -type f \
          \( -name 'ChordVox-Local-Code-Signing.p12' -o -name 'ChordVox-Local-Code-Signing.pem' \) \
          -delete 2>/dev/null || true
      fi
      if [[ "$CREATED_PASSWORD" -eq 1 ]]; then
        /usr/bin/security delete-generic-password \
          -a "$PASSWORD_ACCOUNT" -s "$PASSWORD_SERVICE" "$KEYCHAIN" \
          >/dev/null 2>&1 || true
      fi
      if [[ "$CREATED_PINNED_CERTIFICATE" -eq 1 ]]; then
        /bin/rm -f "$PINNED_CERTIFICATE"
      fi
    fi
    if [[ "$CREATED_TRUST" -eq 1 && -n "$TRUSTED_CERTIFICATE" ]]; then
      /usr/bin/security remove-trusted-cert "$TRUSTED_CERTIFICATE" \
        >/dev/null 2>&1 || true
    fi
    if [[ "$CREATED_IDENTITY" -eq 1 ]]; then
      /usr/bin/security delete-identity -c "$IDENTITY" -t "$KEYCHAIN" \
        >/dev/null 2>&1 || true
    fi
  fi

  case "$WORK_DIR" in
    "${TMPDIR:-/tmp}"/chordvox-codesign.*)
      /usr/bin/find "$WORK_DIR" -depth -delete 2>/dev/null || true
      ;;
    *)
      echo "Refusing to clean unexpected temporary path: $WORK_DIR" >&2
      ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

import_backup_identity() {
  local archive_code
  if [[ ! -f "$P12_BACKUP" || ! -f "$CERTIFICATE_BACKUP" ]]; then
    return 1
  fi
  archive_code="$(/usr/bin/security find-generic-password \
    -a "$PASSWORD_ACCOUNT" -s "$PASSWORD_SERVICE" -w "$KEYCHAIN" 2>/dev/null || true)"
  if [[ -z "$archive_code" ]]; then
    return 1
  fi

  /usr/bin/security import "$P12_BACKUP" \
    -k "$KEYCHAIN" \
    -P "$archive_code" \
    -T /usr/bin/codesign \
    -T /usr/bin/security \
    >/dev/null
  CREATED_IDENTITY=1
  /usr/bin/security add-trusted-cert \
    -r trustRoot \
    -p codeSign \
    -k "$KEYCHAIN" \
    "$CERTIFICATE_BACKUP" \
    >/dev/null
  TRUSTED_CERTIFICATE="$CERTIFICATE_BACKUP"
  CREATED_TRUST=1
  identity_exists
}

bootstrap_identity() {
  if [[ -f "$PINNED_CERTIFICATE" ]]; then
    echo "Error: bootstrap is disabled after the public certificate is pinned." >&2
    echo "Restore the encrypted ChordVox P12 backup instead of creating a new identity." >&2
    return 1
  fi
  if /usr/bin/security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "Error: a certificate named '$IDENTITY' exists but is not a valid identity." >&2
    return 1
  fi
  if [[ -e "$P12_BACKUP" || -e "$CERTIFICATE_BACKUP" ]]; then
    echo "Error: a ChordVox signing backup already exists; bootstrap will not overwrite it." >&2
    return 1
  fi
  if /usr/bin/security find-generic-password \
      -a "$PASSWORD_ACCOUNT" -s "$PASSWORD_SERVICE" "$KEYCHAIN" \
      >/dev/null 2>&1; then
    echo "Error: the ChordVox signing-backup password already exists in the keychain." >&2
    return 1
  fi

  umask 077
  local generated_key_path="$WORK_DIR/codesign.key"
  local certificate="$WORK_DIR/codesign.pem"
  local pkcs12="$WORK_DIR/codesign.p12"
  local archive_code
  archive_code="$(/usr/bin/uuidgen)-$(/usr/bin/uuidgen)"

  "$OPENSSL" req \
    -x509 \
    -newkey rsa:3072 \
    -nodes \
    -sha256 \
    -days 3650 \
    -subj "/CN=$IDENTITY/O=GravityPoet" \
    -addext 'keyUsage=critical,digitalSignature' \
    -addext 'extendedKeyUsage=codeSigning' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'subjectKeyIdentifier=hash' \
    -addext 'authorityKeyIdentifier=keyid:always' \
    -keyout "$generated_key_path" \
    -out "$certificate" \
    >/dev/null 2>&1

  # macOS security import rejects some OpenSSL 3 PKCS#12 profiles. Use the
  # system LibreSSL encoder for a Keychain-compatible encrypted container.
  /usr/bin/openssl pkcs12 \
    -export \
    -inkey "$generated_key_path" \
    -in "$certificate" \
    -out "$pkcs12" \
    -passout "pass:$archive_code" \
    >/dev/null 2>&1

  /usr/bin/security import "$pkcs12" \
    -k "$KEYCHAIN" \
    -P "$archive_code" \
    -T /usr/bin/codesign \
    -T /usr/bin/security \
    >/dev/null
  CREATED_IDENTITY=1
  /usr/bin/security add-trusted-cert \
    -r trustRoot \
    -p codeSign \
    -k "$KEYCHAIN" \
    "$certificate" \
    >/dev/null
  TRUSTED_CERTIFICATE="$certificate"
  CREATED_TRUST=1
  identity_exists

  /bin/mkdir -p "$BACKUP_DIR"
  /bin/chmod 700 "$BACKUP_DIR"
  /usr/bin/touch "$BACKUP_DIR/.metadata_never_index"
  /bin/chmod 600 "$BACKUP_DIR/.metadata_never_index"
  /usr/bin/install -m 600 "$pkcs12" "$P12_BACKUP"
  /usr/bin/install -m 600 "$certificate" "$CERTIFICATE_BACKUP"
  CREATED_BACKUP=1

  /usr/bin/security add-generic-password \
    -a "$PASSWORD_ACCOUNT" \
    -s "$PASSWORD_SERVICE" \
    -w "$archive_code" \
    "$KEYCHAIN" \
    >/dev/null
  CREATED_PASSWORD=1

  /bin/mkdir -p "$(dirname "$PINNED_CERTIFICATE")"
  /usr/bin/install -m 644 "$certificate" "$PINNED_CERTIFICATE"
  CREATED_PINNED_CERTIFICATE=1
}

verify_stable_requirement() {
  local first_dir="$WORK_DIR/first"
  local second_dir="$WORK_DIR/second"
  local first_binary="$first_dir/ChordVoxSigningSmoke"
  local second_binary="$second_dir/ChordVoxSigningSmoke"
  local first_requirement
  local second_requirement

  /bin/mkdir "$first_dir" "$second_dir"
  /bin/cp /bin/echo "$first_binary"
  /bin/cp /bin/date "$second_binary"
  /usr/bin/codesign \
    --force \
    --sign "$IDENTITY" \
    --identifier com.gravitypoet.chordvox.signing-smoke \
    --timestamp=none \
    "$first_binary" \
    >/dev/null
  /usr/bin/codesign \
    --force \
    --sign "$IDENTITY" \
    --identifier com.gravitypoet.chordvox.signing-smoke \
    --timestamp=none \
    "$second_binary" \
    >/dev/null
  /usr/bin/codesign --verify --strict "$first_binary"
  /usr/bin/codesign --verify --strict "$second_binary"

  first_requirement="$(/usr/bin/codesign -d -r- "$first_binary" 2>&1 \
    | /usr/bin/sed -n 's/^designated => //p' \
    | /usr/bin/head -n 1)"
  second_requirement="$(/usr/bin/codesign -d -r- "$second_binary" 2>&1 \
    | /usr/bin/sed -n 's/^designated => //p' \
    | /usr/bin/head -n 1)"
  if [[ -z "$first_requirement" || "$first_requirement" != "$second_requirement" ]]; then
    echo "Error: ChordVox signing requirement changed across different binary contents." >&2
    return 1
  fi
  if [[ "$first_requirement" != *'certificate leaf = H"'* && \
      "$first_requirement" != *'certificate root = H"'* && \
      "$first_requirement" != *'anchor root = H"'* ]]; then
    echo "Error: ChordVox identity did not produce a certificate-bound requirement." >&2
    printf 'actual_requirement=%s\n' "$first_requirement" >&2
    return 1
  fi

  printf 'requirement=%s\n' "$first_requirement"
}

if ! identity_exists; then
  if ! import_backup_identity; then
    if [[ "$BOOTSTRAP" -ne 1 ]]; then
      echo "Error: '$IDENTITY' is unavailable." >&2
      echo "Restore the encrypted P12 backup before building ChordVox." >&2
      exit 1
    fi
    bootstrap_identity
  fi
fi

verify_pinned_identity
verify_stable_requirement

printf 'identity=%s\n' "$IDENTITY"
printf 'certificate_sha256=%s\n' "$(keychain_certificate_fingerprint_sha256)"
if [[ -f "$CERTIFICATE_BACKUP" ]]; then
  printf 'public_certificate=%s\n' "$CERTIFICATE_BACKUP"
fi
if [[ -f "$P12_BACKUP" ]]; then
  printf 'encrypted_backup=%s\n' "$P12_BACKUP"
fi
