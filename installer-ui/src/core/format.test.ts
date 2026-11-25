import { describe, expect, it } from "vitest";

import { formatBytes, langLabel, shortPath } from "./format";

describe("format", () => {
  it("байты: B, KB, MB с одним знаком", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(987)).toBe("987 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("отрицательные и NaN не ломают вывод", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("код языка — верхний регистр", () => {
    expect(langLabel("ru")).toBe("RU");
  });

  it("длинный путь укорачивается с начала", () => {
    const long = `C:/very/long/path/${"x".repeat(80)}/file.dat`;
    const short = shortPath(long, 30);
    expect(short.startsWith("…")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(30);
    expect(short.endsWith("file.dat")).toBe(true);
  });
});
