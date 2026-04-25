// src/test-globals.ts
export const setup = () => {
  process.env.TZ = "Asia/Shanghai";

  if (typeof globalThis.File === "undefined") {
    globalThis.File = class File {
      constructor(parts = [], name = "", options = {}) {
        this.parts = parts;
        this.name = name;
        this.options = options;
      }
    };
  }
};
