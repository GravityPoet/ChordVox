# Commercial Release Checklist (Internal Only)

> [!WARNING]
> Internal use only.  
> Do not publish this document to customers, public website pages, release notes, or marketing materials.
>
> 仅供内部使用。  
> 本文档不得对外公开，不作为客户运营说明或公开售卖说明。

## 1) GitHub Releases automation

This repo ships with `.github/workflows/release.yml`.

- Trigger mode A: push a tag like `v1.5.0`
- Trigger mode B: run workflow manually and pass `version` (`1.5.0`)
- Output: draft GitHub Release with platform installers attached
- Publish target: current repository (`${{ github.repository_owner }}/${{ github.event.repository.name }}`)

### Required GitHub secrets

- `GH_TOKEN` (optional; falls back to `GITHUB_TOKEN`)
- macOS signing/notarization (optional, but required for trusted macOS binaries):
  - `APPLE_CERTIFICATE_BASE64`
  - `APPLE_CERTIFICATE_PASSWORD`
  - `APPLE_API_KEY_BASE64`
  - `APPLE_API_KEY_ID`
  - `APPLE_API_ISSUER`
  - `APPLE_TEAM_ID`

If Apple secrets are not configured, the workflow still builds unsigned macOS artifacts.

### Customer-facing macOS unblock steps (use in release notes/support replies)

For unsigned/notarized-later macOS builds, customers may see Gatekeeper dialogs like:
- "`AriaKey.app` is damaged and can't be opened"
- "Apple cannot verify `AriaKey.app`..."

Use this exact 3-step guidance:

1. Move `AriaKey.app` into `/Applications`.
2. Right-click `AriaKey.app` -> **Open** once.
3. If still blocked, run:

```bash
xattr -dr com.apple.quarantine /Applications/AriaKey.app
open /Applications/AriaKey.app
```

## 2) Desktop license validation skeleton

Main-process license manager:

- File: `src/helpers/licenseManager.js`
- IPC:
  - `license-get-status`
  - `license-activate`
  - `license-validate`
  - `license-clear`
- UI:
  - Account section in settings contains a "Desktop License" panel

### Environment variables (desktop app)

```bash
LICENSE_API_BASE_URL=
LICENSE_PRODUCT_ID=ariakey-pro
LICENSE_API_TOKEN=
LICENSE_API_TIMEOUT_MS=8000
LICENSE_OFFLINE_GRACE_HOURS=168
LICENSE_ALLOW_DEV_KEYS=false
```

### Expected API contract (server side)

- `POST /v1/licenses/activate`
- `POST /v1/licenses/validate`

Request body:

```json
{
  "licenseKey": "XXXX-XXXX-XXXX",
  "productId": "ariakey-pro",
  "machineId": "stable-machine-fingerprint",
  "appVersion": "1.5.0",
  "platform": "darwin",
  "arch": "arm64"
}
```

Typical success response:

```json
{
  "valid": true,
  "status": "active",
  "plan": "pro",
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "offlineGraceHours": 168,
  "message": "License valid"
}
```

When no license API is configured, only keys prefixed with `DEV-` are accepted **and only when** `LICENSE_ALLOW_DEV_KEYS=true` (or `NODE_ENV=development`).

### New: ready-to-run license backend

This repository now includes `services/license-server`:

- API: `POST /v1/licenses/activate`, `POST /v1/licenses/validate`
- Storage: SQLite
- Admin tooling: issue/revoke/list licenses via CLI

See:

- `services/license-server/README.md`
- `docs/LICENSE_SALES_FLOW.md`
