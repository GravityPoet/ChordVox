// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n", () => ({
  default: {
    t: (key: string) => key,
  },
}));

import ErrorBoundary from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  it("does not suppress React commit-deletion NotFoundError outside development", () => {
    const error = new DOMException(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      "NotFoundError"
    );

    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({
      hasError: true,
      error,
    });
  });
});
