import { vi } from "vitest";

if (typeof globalThis.File === "undefined") {
  globalThis.File = class File {
    parts: unknown[];
    name: string;
    options: Record<string, unknown>;

    constructor(parts: unknown[] = [], name: string = "", options: Record<string, unknown> = {}) {
      this.parts = parts;
      this.name = name;
      this.options = options;
    }
  };
}

vi.mock("ntsuspend", () => ({
  suspend: vi.fn(),
  resume: vi.fn(),
}));
