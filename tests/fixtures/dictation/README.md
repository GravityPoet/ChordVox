# Dictation E2E Fixtures

`release-en.wav` is the fixed release-gate audio sample for real local Whisper dictation.

Expected spoken text:

```text
hello world this is a ChordVox release dictation test
```

Release validation should run through `npm run verify:release:dictation`, which injects this WAV into `tests/e2e/dictation-flow.real.spec.ts` and requires a local Whisper model path through `CHORDVOX_RELEASE_DICTATION_WHISPER_MODEL`.

The default expected transcript pattern is:

```text
hello|world|chordvox
```
