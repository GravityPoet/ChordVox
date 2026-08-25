# ChordVox Pro Compliance Notes

ChordVox contains code derived from an upstream MIT-licensed project. See `NOTICE` and `resources/legal/OPEN_SOURCE_NOTICES.txt` for the exact attribution text.

Required actions we implement:

- Keep the ChordVox Pro commercial terms in `LICENSE`
- Keep the upstream MIT license text in `resources/legal/OPEN_SOURCE_NOTICES.txt`
- Keep attribution in `NOTICE`
- Keep the proprietary/open-source boundary in `resources/legal/PROPRIETARY_COMPONENTS.txt`
- Include open source notices in packaged app resources: `resources/legal/OPEN_SOURCE_NOTICES.txt`
- Keep local ASR model provenance and license notes in `docs/legal/MODEL_COMPLIANCE.md`
- Keep server private keys, license peppers, administrator tokens, payment secrets, and shared
  backend credentials out of every desktop artifact
- Treat public AGPL repositories and commercial builds from the private `ChordVox-Pro` repository
  as separate copies whose delivered license notices control

For binary releases, do not remove these files from release assets or installer payloads.
Commercial terms do not retroactively replace MIT or AGPL terms attached to an earlier or public
copy.

## Copyright ownership gate

Repository authorship history contains multiple identities. A Git author line does not by itself
prove or disprove copyright ownership, but it means ChordVox must not be marketed as though one
person unquestionably owns 100% of every line without supporting records.

Before describing a component as exclusively owned proprietary code, retain evidence for at least
one applicable basis:

- it was created by GravityPoet;
- it was created by an employee within an enforceable work-made-for-hire or employment assignment;
- it was assigned under a signed copyright assignment or contributor agreement; or
- its existing license permits the intended proprietary distribution, with all notice and other
  conditions satisfied.

For code copied or merged from a public AGPL repository, confirm the copyright owner of every
material contribution has authorized the commercial license. GravityPoet may dual-license code it
owns, but cannot unilaterally relicense another contributor's AGPL-only contribution. Upstream MIT
code may be included in a proprietary product when its notice and license conditions are retained,
but it does not become exclusively owned by GravityPoet.

Keep the evidence by release:

1. source commit and private repository;
2. dependency lockfile and open-source notices;
3. contributor assignment or applicable inbound license;
4. commercial license version delivered with the artifact; and
5. artifact hash plus the automated package-audit result.

## Customer artifact controls

The customer package is an object-code delivery, not a secrecy boundary:

- `scripts/build-electron.js` bundles and minifies the Electron main process, preloads, and local
  streaming worker without source maps.
- `electron-builder.json` includes the production bundles and renderer output, not the raw
  first-party source/test trees.
- `scripts/verify-mac-package.js` rejects raw first-party TypeScript, tests, source maps, exact
  source-file copies, server-only secret identifiers, or unexpected unpacked first-party code.
- Electron ASAR integrity and `OnlyLoadAppFromAsar` are enabled. `RunAsNode`, `NODE_OPTIONS`, and
  Node CLI inspection are disabled.
- The one required unpacked streaming worker is a bundle. Its SHA-256 is embedded in the protected
  main bundle and verified before the external Node runtime executes it.

Two fuse values are deliberately compatibility-preserving:

- Cookie encryption remains disabled until login migration and rollback behavior have been tested
  against existing customer profiles; the transition is one-way for the Chromium cookie store.
- Extra `file://` privileges remain enabled because the current renderer loads local files with
  `loadFile()`. Disable this only after migrating the renderer to a privileged custom protocol and
  completing cross-platform E2E tests.

Bundling, minification, ASAR integrity, worker hashing, and code signing increase reverse-engineering
and tampering cost. They cannot prevent a determined customer who controls the device from studying
runtime behavior or reconstructing logic. Secrets and any logic that must remain confidential must
run on controlled server infrastructure.
