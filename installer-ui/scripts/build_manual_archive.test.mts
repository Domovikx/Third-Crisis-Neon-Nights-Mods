/**
 * Тесты ручного архива: состав, запрещённые типы, FOMOD. Реальная упаковка —
 * в `manual_e2e.mts` (нужен 7-Zip и собранный payload).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FORBIDDEN_EXTENSIONS,
  forbiddenDistEntries,
  expectedEntries,
  fomodInfo,
  fomodModule,
  forbiddenEntries,
  manualReadme,
  parseArgs,
} from "./build_manual_archive.mts";

test("в архиве нет исполняемых типов: детектор ловит .ps1/.cmd/.exe", () => {
  const bad = ["install.ps1", "setup.cmd", "run.EXE", "a/b/tool.bat", "x.vbs"];
  assert.deepEqual(forbiddenEntries(bad), bad);
  const good = [
    "dwmapi.dll",
    "mods/NeonTranslatorDX/NeonTranslatorDX.dll",
    "mods/NeonTranslatorDX/patch_ru.dat",
    "README-INSTALL.md",
    "fomod/info.xml",
  ];
  assert.deepEqual(forbiddenEntries(good), []);
});

test("список запрещённых расширений покрывает exe/cmd/ps1", () => {
  for (const ext of [".exe", ".cmd", ".ps1"]) {
    assert.ok(FORBIDDEN_EXTENSIONS.includes(ext), ext);
  }
});

test("контракт раскладки: лоадер, папка мода, README, fomod; без скриптов", () => {
  const entries = expectedEntries(["ru", "de"]);
  assert.ok(entries.includes("dwmapi.dll"));
  assert.ok(entries.includes("mods/NeonTranslatorDX/NeonTranslatorDX.dll"));
  assert.ok(entries.includes("mods/NeonTranslatorDX/patch_ru.dat"));
  assert.ok(entries.includes("mods/NeonTranslatorDX/patch_de.dat"));
  assert.ok(entries.includes("mods/NeonTranslatorDX/active_lang.txt"));
  assert.ok(entries.includes("README-INSTALL.md"));
  assert.ok(entries.includes("fomod/info.xml"));
  assert.ok(entries.includes("fomod/ModuleConfig.xml"));
  assert.equal(forbiddenEntries(entries).length, 0);
  assert.ok(!entries.some((entry) => entry.endsWith(".ps1")));
});

test("FOMOD раскладывает те же пути и не содержит исполняемых файлов", () => {
  const config = fomodModule();
  assert.match(config, /<file source="dwmapi\.dll"\/>/);
  assert.match(
    config,
    /<folder source="mods\/NeonTranslatorDX" destination="mods\/NeonTranslatorDX"\/>/,
  );
  assert.doesNotMatch(config, /\.(exe|cmd|ps1)/i);

  const info = fomodInfo("2026.11.25");
  assert.match(info, /<Version MachineVersion="2026\.11\.25">2026\.11\.25<\/Version>/);
  assert.match(info, /No executable files/);
});

test("README: 3 шага, манифест рантайма, DLL-предупреждение, без запуска скриптов", () => {
  const readme = manualReadme("2026.11.25");
  assert.match(readme, /Установка \(3 шага\)/);
  assert.match(readme, /2026\.11\.25/);
  assert.doesNotMatch(readme, /\{\{VERSION\}\}/);
  assert.match(readme, /install-manifest\.json/);
  assert.match(readme, /запустите игру \*\*один раз\*\*/i);
  assert.match(readme, /dwmapi\.dll/);
  assert.match(readme, /DLL-hijack/);
  assert.match(readme, /антивирус/i);
  assert.match(readme, /Распакуйте новый архив \*\*поверх\*\*/);
  assert.match(readme, /Удаление/);
  assert.doesNotMatch(readme, /powershell/i);
});

test("dist: исполняемые артефакты запрещены, exe менеджера — исключение", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntdx-dist-"));
  try {
    writeFileSync(join(dir, "archive.7z"), "");
    writeFileSync(join(dir, "NeonTranslatorDXManager.exe"), "");
    writeFileSync(join(dir, "setup.ps1"), "");
    writeFileSync(join(dir, "run.cmd"), "");
    assert.deepEqual(forbiddenDistEntries(dir).sort(), ["run.cmd", "setup.ps1"]);
    unlinkSync(join(dir, "setup.ps1"));
    unlinkSync(join(dir, "run.cmd"));
    assert.deepEqual(forbiddenDistEntries(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs: версия и каталог", () => {
  const args = parseArgs(["--version", "1.2.3", "--out", "tmp/x"]);
  assert.equal(args.version, "1.2.3");
  assert.ok(args.out.endsWith("tmp\\x") || args.out.endsWith("tmp/x"));
  assert.equal(args.reuse, false);
});
