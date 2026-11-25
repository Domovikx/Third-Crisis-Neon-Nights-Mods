import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GameInfo, PayloadStatus } from "@/core/types";
import { Done } from "./Done";
import { Detect } from "./Detect";
import { Installing } from "./Installing";
import { Uninstall } from "./Uninstall";
import { Verify } from "./Verify";
import { Welcome } from "./Welcome";

const html = (element: ReactElement) => renderToStaticMarkup(element);

const game: GameInfo = {
  path: "C:\\Games\\Third Crisis Neon Nights",
  library: "C:\\Program Files (x86)\\Steam",
  buildId: "9876543",
  modInstalled: false,
  installedLang: null,
};

const payload: PayloadStatus = {
  dir: "C:\\payload",
  exists: true,
  version: "2026.11.25",
  langs: ["de", "en", "ru"],
};

const noop = () => {};

describe("Welcome", () => {
  it("ru: заголовок, состав пакета и версия payload", () => {
    const markup = html(<Welcome locale="ru" payload={payload} ready onStart={noop} />);
    expect(markup).toContain("Установка перевода");
    expect(markup).toContain("dwmapi.dll");
    expect(markup).toContain("mods/NeonTranslatorDX/");
    expect(markup).toContain("Пакет: 2026.11.25 · языков: 3");
    expect(markup).toContain('data-testid="Welcome--start"');
  });

  it("en: те же элементы по-английски", () => {
    const markup = html(<Welcome locale="en" payload={payload} ready onStart={noop} />);
    expect(markup).toContain("Install the translation");
    expect(markup).toContain("Package: 2026.11.25 · languages: 3");
  });

  it("нет payload — предупреждение", () => {
    const markup = html(
      <Welcome
        locale="ru"
        payload={{ ...payload, exists: false, langs: [] }}
        ready
        onStart={noop}
      />,
    );
    expect(markup).toContain("нет папки payload");
  });
});

describe("Detect", () => {
  const base = {
    locale: "ru" as const,
    detecting: false,
    folderError: null,
    folderMissing: [],
    payload,
    busy: false,
    error: null,
    onChooseFolder: noop,
    onInstall: noop,
    onUninstall: noop,
    onVerify: noop,
  };

  it("игра найдена: путь, кнопки установки и проверки", () => {
    const markup = html(<Detect {...base} game={game} />);
    expect(markup).toContain("Игра найдена");
    expect(markup).toContain(game.path);
    expect(markup).toContain('data-testid="Detect--install"');
    expect(markup).toContain('data-testid="Detect--verify"');
    // Мод не стоит — кнопки удаления нет.
    expect(markup).not.toContain('data-testid="Detect--uninstall"');
  });

  it("мод стоит: удаление и «переустановить»", () => {
    const markup = html(
      <Detect {...base} game={{ ...game, modInstalled: true, installedLang: "de" }} />,
    );
    expect(markup).toContain("Мод установлен");
    expect(markup).toContain(">DE<");
    expect(markup).toContain('data-testid="Detect--uninstall"');
    expect(markup).toContain("Переустановить");
  });

  it("не найдена: выбор папки и подсказка по маркерам", () => {
    const markup = html(
      <Detect
        {...base}
        game={null}
        folderError="game-invalid"
        folderMissing={["Third Crisis Neon Nights.exe"]}
      />,
    );
    expect(markup).toContain("Игра не найдена");
    expect(markup).toContain('data-testid="Detect--choose"');
    expect(markup).toContain("не хватает Third Crisis Neon Nights.exe");
  });

  it("поиск идёт: сообщение вместо карточки", () => {
    const markup = html(<Detect {...base} game={null} detecting />);
    expect(markup).toContain("Ищем Third Crisis");
    expect(markup).not.toContain('data-testid="Detect--choose"');
  });

  it("en: локализует кнопки", () => {
    const markup = html(<Detect {...base} locale="en" game={game} />);
    expect(markup).toContain("Game found");
    expect(markup).toContain(">Check installation<");
  });
});

describe("Installing", () => {
  it("прогресс и имя файла", () => {
    const markup = html(
      <Installing
        locale="ru"
        progress={{ done: 3, total: 10, path: "mods/NeonTranslatorDX/patch_ru.dat" }}
        error={null}
        onRetry={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("30%");
    expect(markup).toContain("3 из 10");
    expect(markup).toContain("patch_ru.dat");
  });

  it("ошибка: текст по коду и кнопки", () => {
    const markup = html(
      <Installing
        locale="ru"
        progress={null}
        error="payload-missing: нет папки payload"
        onRetry={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Установка не удалась");
    expect(markup).toContain("Пакет установки не найден");
    expect(markup).toContain('data-testid="Installing--retry"');
  });
});

describe("Done", () => {
  it("итоги установки", () => {
    const markup = html(
      <Done
        locale="ru"
        result={{
          lang: "ru",
          payloadVersion: "2026.11.25",
          files: [],
          copied: 14,
          bytes: 3 * 1024 * 1024,
          manifestPath: "x",
          removedStale: ["old.dat"],
        }}
        onVerify={noop}
        onClose={noop}
      />,
    );
    expect(markup).toContain("Готово");
    expect(markup).toContain("Файлов");
    expect(markup).toContain(">14<");
    expect(markup).toContain("3.0 MB");
    expect(markup).toContain(">RU<");
  });
});

describe("Uninstall", () => {
  it("подтверждение", () => {
    const markup = html(
      <Uninstall
        locale="ru"
        game={game}
        busy={false}
        result={null}
        error={null}
        onConfirm={noop}
        onCancel={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Удаление");
    expect(markup).toContain("Сохранения и файлы игры не трогаются");
    expect(markup).toContain('data-testid="Uninstall--confirm"');
  });

  it("результат с оставленными файлами", () => {
    const markup = html(
      <Uninstall
        locale="ru"
        game={game}
        busy={false}
        result={{ deleted: ["a", "b"], kept: ["c"], removedDirs: ["mods"], manifestDeleted: true }}
        error={null}
        onConfirm={noop}
        onCancel={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Мод удалён");
    expect(markup).toContain("Удалено файлов: 2");
    expect(markup).toContain("Оставлено (изменены или чужие)");
    expect(markup).toContain(">1<");
  });
});

describe("Verify", () => {
  it("целостность в порядке", () => {
    const markup = html(
      <Verify
        locale="ru"
        result={{
          installed: true,
          ok: true,
          checked: 14,
          lang: "ru",
          missing: [],
          modified: [],
          invalid: [],
          unlisted: [],
        }}
        busy={false}
        error={null}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Установка цела: все 14 файлов на месте.");
  });

  it("не установлен", () => {
    const markup = html(
      <Verify
        locale="ru"
        result={{
          installed: false,
          ok: false,
          checked: 0,
          lang: null,
          missing: [],
          modified: [],
          invalid: [],
          unlisted: [],
        }}
        busy={false}
        error={null}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Мод не установлен.");
  });

  it("список проблем", () => {
    const markup = html(
      <Verify
        locale="en"
        result={{
          installed: true,
          ok: false,
          checked: 14,
          lang: "ru",
          missing: ["mods/NeonTranslatorDX/patch_ru.dat"],
          modified: [
            { path: "mods/NeonTranslatorDX/NeonTranslatorDX.dll", expected: "a", actual: "b" },
          ],
          invalid: [],
          unlisted: ["mods/NeonTranslatorDX/extra.bin"],
        }}
        busy={false}
        error={null}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Missing files: 1");
    expect(markup).toContain("patch_ru.dat");
    expect(markup).toContain("Extra files");
  });
});
