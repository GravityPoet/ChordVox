export function calculateMicrophoneLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0;

  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.min(1, Math.max(0, rms * 4));
}
