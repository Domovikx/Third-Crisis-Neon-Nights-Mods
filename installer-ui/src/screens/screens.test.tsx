import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  GameInfo,
  InstallResult,
  PayloadStatus,
  StatusResult,
  VerifyResult,
} from "@/core/types";
import { Done } from "./Done";
import { Progress } from "./Progress";
import { Status } from "./Status";
import { Uninstall } from "./Uninstall";
import { Verify } from "./Verify";

const html = (element: ReactElement) => renderToStaticMarkup(element);
const noop = () => {};

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
  version: "2026.12.01",
  langs: ["de", "en", "ru"],
};

const installed: StatusResult = {
  installed: true,
  modDirExists: true,
  manifestFound: true,
  version: "2026.11.25",
  lang: "ru",
  files: 14,
  installedAt: "2026-11-25T10:00:00.000Z",
  integrity: { state: "ok", checked: 14, missing: 0, modified: 0, unlisted: 0 },
  problem: null,
};

const notInstalled: StatusResult = {
  installed: false,
  modDirExists: false,
  manifestFound: false,
  version: null,
  lang: null,
  files: 0,
  installedAt: null,
  integrity: { state: "unknown", checked: 0, missing: 0, modified: 0, unlisted: 0 },
  problem: null,
};

const statusBase = {
  locale: "ru" as const,
  game,
  payload,
  detecting: false,
  folderError: null,
  folderMissing: [] as string[],
  busy: false,
  error: null,
  onRefresh: noop,
  onChooseFolder: noop,
  onInstall: noop,
  onUpdate: noop,
  onVerify: noop,
  onUninstall: noop,
};

const installResult: InstallResult = {
  lang: "ru",
  payloadVersion: "2026.12.01",
  files: [],
  copied: 3,
  skipped: 11,
  bytes: 2048,
  manifestPath: "x",
  removedStale: ["mods/NeonTranslatorDX/patch_it.dat"],
};

describe("Status", () => {
  it("мод не установлен: только «Установить», версия пакета", () => {
    const markup = html(<Status {...statusBase} status={notInstalled} />);
    expect(markup).toContain("Состояние мода");
    expect(markup).toContain("Игра найдена");
    expect(markup).toContain("Не установлен");
    expect(markup).toContain('data-testid="Status--install"');
    expect(markup).not.toContain('data-testid="Status--update"');
    expect(markup).not.toContain('data-testid="Status--uninstall"');
    expect(markup).toContain("Пакет: 2026.12.01 · языков: 3");
  });

  it("мод стоит: версия, язык, файлы, целостность и кнопки менеджера", () => {
    const markup = html(<Status {...statusBase} status={installed} />);
    expect(markup).toContain("Установлен");
    expect(markup).toContain("2026.11.25");
    expect(markup).toContain(">RU<");
    expect(markup).toContain(">14<");
    expect(markup).toContain("Целостность: ok");
    expect(markup).toContain("Доступно обновление: 2026.11.25 → 2026.12.01");
    expect(markup).toContain('data-testid="Status--update"');
    expect(markup).toContain('data-testid="Status--verify"');
    expect(markup).toContain('data-testid="Status--uninstall"');
    expect(markup).not.toContain('data-testid="Status--install"');
  });

  it("версии совпадают — обновление не предлагается", () => {
    const markup = html(
      <Status {...statusBase} status={{ ...installed, version: payload.version }} />,
    );
    expect(markup).not.toContain("Доступно обновление");
    expect(markup).toContain('data-testid="Status--update"');
  });

  it("целостность: не хватает / изменены / манифест повреждён", () => {
    const missing = html(
      <Status
        {...statusBase}
        status={{
          ...installed,
          integrity: { ...installed.integrity, state: "missing", missing: 2 },
        }}
      />,
    );
    expect(missing).toContain("не хватает файлов: 2");

    const modified = html(
      <Status
        {...statusBase}
        status={{
          ...installed,
          integrity: { ...installed.integrity, state: "modified", modified: 1 },
        }}
      />,
    );
    expect(modified).toContain("изменены: 1");

    const broken = html(
      <Status
        {...statusBase}
        status={{ ...installed, integrity: { ...installed.integrity, state: "broken" } }}
      />,
    );
    expect(broken).toContain("манифест повреждён");
  });

  it("игра не найдена: выбор папки и подсказка", () => {
    const markup = html(
      <Status
        {...statusBase}
        game={null}
        status={null}
        folderError="game-invalid"
        folderMissing={["Third Crisis Neon Nights.exe"]}
      />,
    );
    expect(markup).toContain("Игра не найдена");
    expect(markup).toContain('data-testid="Status--choose"');
    expect(markup).toContain("не хватает Third Crisis Neon Nights.exe");
  });

  it("нет payload: установка недоступна и есть предупреждение", () => {
    const markup = html(
      <Status
        {...statusBase}
        status={notInstalled}
        payload={{ ...payload, exists: false, langs: [] }}
      />,
    );
    expect(markup).toContain("нет payload");
    expect(markup).toMatch(/disabled[^>]*data-testid="Status--install"/);
  });

  it("en: локализует статус", () => {
    const markup = html(<Status {...statusBase} locale="en" status={installed} />);
    expect(markup).toContain("Mod status");
    expect(markup).toContain("Update available");
    expect(markup).toContain(">Update<");
  });
});

describe("Progress", () => {
  it("установка: заголовок, процент, файл", () => {
    const markup = html(
      <Progress
        locale="ru"
        op="install"
        progress={{ done: 3, total: 10, path: "mods/NeonTranslatorDX/patch_ru.dat" }}
        error={null}
        onRetry={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Установка");
    expect(markup).toContain("30%");
    expect(markup).toContain("3 из 10");
    expect(markup).toContain("patch_ru.dat");
  });

  it("обновление: свой заголовок и кнопки при ошибке", () => {
    const markup = html(
      <Progress
        locale="ru"
        op="update"
        progress={null}
        error="manifest-missing: нет манифеста"
        onRetry={noop}
        onBack={noop}
      />,
    );
    expect(markup).toContain("Обновление");
    expect(markup).toContain("сначала нажмите «Установить»");
    expect(markup).toContain('data-testid="Progress--retry"');
    expect(markup).toContain('data-testid="Progress--back"');
  });
});

describe("Done", () => {
  it("обновление: записано/пропущено/удалено", () => {
    const markup = html(
      <Done locale="ru" op="update" result={installResult} onVerify={noop} onBack={noop} />,
    );
    expect(markup).toContain("Обновлено");
    expect(markup).toContain("Записано файлов");
    expect(markup).toContain(">3<");
    expect(markup).toContain("Пропущено (уже совпадали)");
    expect(markup).toContain("Удалено из прошлой установки");
    expect(markup).toContain("2026.12.01");
  });

  it("установка: заголовок «Установлено»", () => {
    const markup = html(
      <Done locale="en" op="install" result={installResult} onVerify={noop} onBack={noop} />,
    );
    expect(markup).toContain("Installed");
    expect(markup).toContain("Files written");
  });
});

describe("Verify", () => {
  const ok: VerifyResult = {
    installed: true,
    ok: true,
    checked: 14,
    lang: "ru",
    missing: [],
    modified: [],
    invalid: [],
    unlisted: [],
  };

  it("целостность в порядке", () => {
    const markup = html(<Verify locale="ru" result={ok} busy={false} error={null} onBack={noop} />);
    expect(markup).toContain("Установка цела: все 14 файлов на месте.");
  });

  it("не установлен", () => {
    const markup = html(
      <Verify
        locale="ru"
        result={{ ...ok, installed: false, ok: false, checked: 0, lang: null }}
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
          ...ok,
          ok: false,
          missing: ["mods/NeonTranslatorDX/patch_ru.dat"],
          modified: [
            { path: "mods/NeonTranslatorDX/NeonTranslatorDX.dll", expected: "a", actual: "b" },
          ],
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

  it("результат", () => {
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
  });
});
