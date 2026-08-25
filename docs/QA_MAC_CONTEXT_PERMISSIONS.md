# macOS Context Permission QA

This checklist verifies the ChordVox context capture permission flow on macOS.
Run it on a test Mac or test user account, because resetting TCC permissions
changes local privacy grants for ChordVox.

## Scope

- Text context permission: Accessibility.
- Vision context permission: Screen Recording.
- Helper UI: the floating permission helper launched from ChordVox.
- In-app state: Settings > AI Models > Context.

## Preconditions

1. Install the build under test in `/Applications/ChordVox.app`.
2. Quit all running ChordVox processes.
3. Confirm the app bundle id is `com.gravitypoet.chordvox`.
4. Use a macOS account where losing ChordVox privacy grants is acceptable.

## Reset Privacy State

Run only on a test machine or disposable macOS user:

```bash
tccutil reset Accessibility com.gravitypoet.chordvox
tccutil reset ScreenCapture com.gravitypoet.chordvox
tccutil reset Microphone com.gravitypoet.chordvox
```

Then open ChordVox from `/Applications`.

## Text Context Flow

1. Open Settings.
2. Go to AI Models > Context.
3. Enable Text Context.
4. Click the Accessibility permission card.
5. Expected: macOS opens System Settings > Privacy & Security > Accessibility.
6. Expected: ChordVox shows the floating permission helper.
7. Expected: helper copy fits without clipping in English and Chinese UI.
8. Expected: helper button opens Accessibility settings again when clicked.
9. Grant Accessibility permission to ChordVox.
10. Expected: the in-app Accessibility badge refreshes to granted within 5 seconds.
11. Expected: the helper closes or changes to granted state without requiring app restart.

## Vision Context Flow

1. Stay in Settings > AI Models > Context.
2. Enable Vision Context.
3. Click the Screen Recording permission card.
4. Expected: macOS opens System Settings > Privacy & Security > Screen Recording.
5. Expected: ChordVox shows the floating permission helper with screen-recording copy.
6. Expected: helper button opens Screen Recording settings, not Accessibility.
7. Grant Screen Recording permission to ChordVox.
8. If macOS requires restart, restart ChordVox.
9. Expected: the in-app Screen Recording badge refreshes to granted after restart or within 5 seconds when restart is not required.
10. Click Test Vision.
11. Expected: if the selected reasoning model supports vision and has a valid key, the result shows supported; otherwise the app shows a clear unsupported or missing-key state.

## Regression Checks

1. Disable Text Context.
2. Expected: Accessibility badge disappears when only Vision Context remains enabled.
3. Disable Vision Context.
4. Expected: permission cards are hidden and context capture is off.
5. Reopen Settings.
6. Expected: Text Context and Vision Context toggles persist separately.
7. Toggle the app language between English and Chinese.
8. Expected: helper labels, permission cards, and error messages remain localized and unclipped.
9. Remove Accessibility or Screen Recording permission from System Settings while ChordVox is open.
10. Expected: the corresponding badge returns to warning within 5 seconds while the context layer is enabled.

## Pass Criteria

- Text Context can be enabled, authorized, detected, disabled, and persisted.
- Vision Context can be enabled, authorized, detected, disabled, and persisted.
- The helper opens the correct macOS privacy pane for each permission.
- No helper text or button overlaps at the default helper size.
- The app never claims context capture is available when the required macOS permission is missing.

## Failure Notes

When a step fails, record:

- ChordVox version and git SHA.
- macOS version and CPU architecture.
- UI language.
- Whether the app was launched from `/Applications` or directly from a build folder.
- Screenshot of the permission helper and the in-app permission card.
- Output from:

```bash
log show --last 5m --predicate 'process == "ChordVox"' --style compact
```
