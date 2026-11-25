import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { createMockPlatform } from "./platform/mock";

describe("App (SSR-смоук)", () => {
  it("открывается на приветствии и показывает демо-баннер в мок-режиме", () => {
    const markup = renderToStaticMarkup(<App platform={createMockPlatform()} />);
    expect(markup).toContain("NeonTranslatorDX");
    expect(markup).toContain("Установка перевода");
    expect(markup).toContain("Демо-режим без Tauri");
    expect(markup).toContain('data-testid="App--locale-en"');
  });

  it("переключение локали меняет словарь", () => {
    const markup = renderToStaticMarkup(<App platform={createMockPlatform()} />);
    expect(markup).toContain("Язык интерфейса");
    expect(markup).toContain("Перевод Third Crisis: Neon Nights");
  });
});
