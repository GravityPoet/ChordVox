import { getPlatform } from "../../utils/platform";

const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Digit0: "0",
  Minus: "-",
  Equal: "=",
  KeyQ: "Q",
  KeyW: "W",
  KeyE: "E",
  KeyR: "R",
  KeyT: "T",
  KeyY: "Y",
  KeyU: "U",
  KeyI: "I",
  KeyO: "O",
  KeyP: "P",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  KeyF: "F",
  KeyG: "G",
  KeyH: "H",
  KeyJ: "J",
  KeyK: "K",
  KeyL: "L",
  Semicolon: ";",
  Quote: "'",
  KeyZ: "Z",
  KeyX: "X",
  KeyC: "C",
  KeyV: "V",
  KeyB: "B",
  KeyN: "N",
  KeyM: "M",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  Escape: "Esc",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
  F13: "F13",
  F14: "F14",
  F15: "F15",
  F16: "F16",
  F17: "F17",
  F18: "F18",
  F19: "F19",
  F20: "F20",
  F21: "F21",
  F22: "F22",
  F23: "F23",
  F24: "F24",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Pause: "Pause",
  ScrollLock: "Scrolllock",
  PrintScreen: "PrintScreen",
  NumLock: "Numlock",
  Numpad0: "num0",
  Numpad1: "num1",
  Numpad2: "num2",
  Numpad3: "num3",
  Numpad4: "num4",
  Numpad5: "num5",
  Numpad6: "num6",
  Numpad7: "num7",
  Numpad8: "num8",
  Numpad9: "num9",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
  NumpadEnter: "Enter",
  MediaPlayPause: "MediaPlayPause",
  MediaStop: "MediaStop",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPreviousTrack",
};

export const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

export function mapKeyboardEventToHotkey(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) {
    return null;
  }

  const baseKey = CODE_TO_KEY[e.code];
  if (!baseKey) {
    return null;
  }

  const platform = getPlatform();
  const modifiers: string[] = [];

  if (platform === "darwin") {
    if (e.ctrlKey) modifiers.push("Control");
    if (e.metaKey) modifiers.push("Command");
  } else {
    if (e.ctrlKey) modifiers.push("Control");
    if (e.metaKey) modifiers.push("Super");
  }

  if (e.altKey) modifiers.push("Alt");
  if (e.shiftKey) modifiers.push("Shift");

  return modifiers.length > 0 ? [...modifiers, baseKey].join("+") : baseKey;
}
