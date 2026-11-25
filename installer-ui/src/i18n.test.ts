import { describe, expect, it } from "vitest";

import { MESSAGES, errorText, parseError, t } from "@/i18n";

describe("i18n", () => {
  it("ru и en содержат ровно один набор ключей", () => {
    const ru = Object.keys(MESSAGES.ru).sort();
    const en = Object.keys(MESSAGES.en).sort();
    expect(en).toEqual(ru);
    expect(ru.length).toBeGreaterThan(50);
  });

  it("ни одна строка не пустая", () => {
    for (const locale of ["ru", "en"] as const) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("подставляет параметры и не теряет неизвестные плейсхолдеры", () => {
    expect(t("ru", "doneCopied", { count: 7 })).toBe("Записано файлов: 7");
    expect(t("en", "progressFile", { done: 2, total: 5, path: "a.dat" })).toBe("2 of 5: a.dat");
    expect(t("ru", "doneCopied")).toContain("{count}");
  });

  it("разбирает ошибку Rust и переводит известные коды", () => {
    expect(parseError("payload-missing: нет папки")).toEqual({
      code: "payload-missing",
      detail: "нет папки",
    });
    expect(parseError("io")).toEqual({ code: "io", detail: "" });
    expect(errorText("ru", "game-invalid: нет exe")).toBe("Папка не похожа на установку игры.");
    expect(errorText("en", "io: disk")).toBe("File system error.");
    expect(errorText("ru", "weird: подробность")).toBe("Неизвестная ошибка: подробность");
  });
});
