import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { createMockPlatform } from "./platform/mock";

describe("App (SSR-смоук)", () => {
  it("открывается на статусе менеджера и показывает демо-баннер", () => {
    const markup = renderToStaticMarkup(<App platform={createMockPlatform()} />);
    expect(markup).toContain("NeonTranslatorDX Manager");
    expect(markup).toContain("Состояние мода");
    expect(markup).toContain("Демо-режим без Tauri");
    expect(markup).toContain('data-testid="App--locale-en"');
  });

  it("окно менеджера: подзаголовок и переключатель языка", () => {
    const markup = renderToStaticMarkup(<App platform={createMockPlatform()} />);
    expect(markup).toContain("Язык интерфейса");
    expect(markup).toContain("Third Crisis: Neon Nights — перевод под управлением");
  });
});
