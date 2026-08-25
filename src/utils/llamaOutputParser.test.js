import { describe, it, expect } from "vitest";
import { parseLlamaCppOutput, DIAGNOSTIC_PATTERNS, END_TOKEN_PATTERNS } from "./llamaOutputParser";

describe("DIAGNOSTIC_PATTERNS", () => {
  it("locks the diagnostic patterns", () => {
    expect(DIAGNOSTIC_PATTERNS).toBeDefined();
    expect(DIAGNOSTIC_PATTERNS.length).toBeGreaterThan(0);
  });

  it("matches common llama.cpp CLI logs", () => {
    // llama_log_info
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("llama_model_loader: loaded"))).toBe(true);
    // ggml_init
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("ggml_metal_init: allocating"))).toBe(true);
    // main:
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("main: build 1234"))).toBe(true);
    // load time =
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("  load time =   123.45 ms"))).toBe(true);
    // Log start
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("Log start"))).toBe(true);
    // Using Metal backend
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("Using Metal backend"))).toBe(true);
    // n_threads
    expect(DIAGNOSTIC_PATTERNS.some((p) => p.test("n_threads = 4"))).toBe(true);
  });
});

describe("END_TOKEN_PATTERNS", () => {
  it("matches common LLM end tokens", () => {
    expect(END_TOKEN_PATTERNS.some((p) => p.test("hello<|im_end|>"))).toBe(true);
    expect(END_TOKEN_PATTERNS.some((p) => p.test("world<|end|>"))).toBe(true);
    expect(END_TOKEN_PATTERNS.some((p) => p.test("test</s>"))).toBe(true);
    expect(END_TOKEN_PATTERNS.some((p) => p.test("done[end of text]"))).toBe(true);
  });
});

describe("parseLlamaCppOutput", () => {
  it("extracts generated text and removes diagnostics", () => {
    const raw = [
      "llama_model_loader: loaded 128 tensors",
      "system_info: n_threads = 8",
      "main: build 2000",
      "",
      "This is the actual response from the model.",
      "It has multiple lines.",
      "",
      "  eval time =   12.34 ms / 5 tokens",
      "total time =   54.32 ms",
    ].join("\n");

    const expected = ["This is the actual response from the model.", "It has multiple lines."].join(
      "\n"
    );

    expect(parseLlamaCppOutput(raw)).toBe(expected);
  });

  it("removes end tokens from the end of the text", () => {
    expect(parseLlamaCppOutput("This is response <|im_end|>")).toBe("This is response");
    expect(parseLlamaCppOutput("This is response </s>")).toBe("This is response");
    expect(parseLlamaCppOutput("This is response\n[end of text]")).toBe("This is response");
  });

  it("handles null, undefined and empty strings", () => {
    expect(parseLlamaCppOutput("")).toBe("");
    expect(parseLlamaCppOutput(null)).toBe("");
    expect(parseLlamaCppOutput(undefined)).toBe("");
  });
});
