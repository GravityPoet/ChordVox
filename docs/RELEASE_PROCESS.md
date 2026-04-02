# Release Process

## Channels

### Customer release
- Purpose: customer installs, in-app updates, accessibility permission continuity
- Requirements:
  - fixed bundle identifier
  - official Developer ID signing
  - notarization enabled
- Commands:
  - `npm run build:mac:customer`
  - GitHub Actions: `.github/workflows/release.yml`

### Internal test build
- Purpose: local QA, temporary feature verification
- Not suitable for customer updates
- Characteristics:
  - ad-hoc signing
  - notarization disabled
  - may trigger macOS to ask for Accessibility permission again
- Command:
  - `npm run build:mac:test`

## Rules

1. Never use ad-hoc mac builds as customer update packages.
2. Customer mac releases must come from the signed workflow only.
3. If Apple signing secrets are missing, the customer release workflow must fail closed.
4. When validating permission continuity, always test with:
   - the signed customer package
   - the same `/Applications/ChordVox.app` install path

## Why this matters

macOS Accessibility permission continuity is tied to the app identity seen by the system:
- bundle identifier
- code signing identity
- app replacement path

Unsigned or ad-hoc replacement builds can be treated like a different app, even if the app name is the same.
