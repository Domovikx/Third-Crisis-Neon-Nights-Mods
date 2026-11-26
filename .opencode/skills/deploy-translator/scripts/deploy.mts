/**
 * deploy.mts — установка/удаление рантайм-переводчика в игре.
 *
 * Раскладка «одна папка» (2026-11-24):
 *
 *   <игра>/dwmapi.dll                     лоадер (единственный файл вне папки)
 *   <игра>/mods/NeonTranslatorDX/
 *     NeonTranslatorDX.dll
 *     fonts/{RobotoCondensed-Regular,NotoSansSC,NotoSansJP,...}.ttf
 *     patch_<lang>.dat
 *     active_lang.txt
 *     install-manifest.json               что поставлено: файл, размер, sha256
 *
 * Рантайм разрешает шрифты/словарь/`active_lang.txt` относительно
 * собственной сборки (`Assembly.Location`), прокси грузит DLL по пути
 * `<игра>/mods/NeonTranslatorDX/NeonTranslatorDX.dll`.
 *
 * Команды:
 *   deploy (по умолчанию) — поставить;
 *   `--uninstall` — удалить ровно то, что записано в манифесте (чужие файлы
 *     не трогаются), затем пустые папки;
 *   `--migrate` — после установки убрать артефакты ПРЕЖНЕЙ раскладки из
 *     `Managed/` (и мусор сборки из корня игры), с логом каждого удаления.
 *
 * CLI:
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru --dry-run
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang en
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang de --rebuild --proxy
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --uninstall
 *   node .opencode/skills/deploy-translator/scripts/deploy.mts --lang ru --migrate
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { GAME_DATA_FOLDER } from "../../../../scripts/game_dir.mts";
import { REPO_ROOT, SOURCE_LANG, allLangs } from "../../../../scripts/languages.mts";
import { l10nBinary } from "../../../../scripts/text_cli.mts";
import { buildRuntime, resolveGame } from "../../build-translator/scripts/build.mts";
import { buildProxy } from "../../build-translator/scripts/build_proxy.mts";

/** Папка модов в установке (единая конвенция с TSSR). */
export const MODS_FOLDER = "mods";

/** Папка мода внутри `mods/`: сюда идёт ВСЁ, кроме лоадера. */
export const MOD_FOLDER = "NeonTranslatorDX";

/** Имя рантайм-сборки внутри папки мода. */
export const RUNTIME_DLL = "NeonTranslatorDX.dll";

/** Прежние папки установки в корне игры — только для `--migrate`. */
export const LEGACY_MOD_FOLDERS = ["NeonTranslatorDX", "NeonTranslator"];

/** Имя файла установки: список поставленного + хэши (для uninstall). */
export const MANIFEST_NAME = "install-manifest.json";

/** Подпапка шрифтов внутри папки мода. */
export const FONT_SUBDIR = "fonts";

/** Шрифты, которые кладутся в `fonts/` (CJK — необязательные). */
export const CJK_FONTS = [
  "NotoSansSC.ttf",
  "NotoSansJP.ttf",
  "NotoSansKR.ttf",
  "NotoSansMarks.ttf",
];

/** Основной шрифт с кириллицей (обязателен). */
export const MAIN_FONT = "RobotoCondensed-Regular.ttf";

/** Политика CJK-типографики: кладётся рядом со шрифтами, читается рантаймом. */
export const TYPOGRAPHY = "typography.json";

/** Шрифты-кандидаты для скрытой страницы сравнения (Ctrl+F12 -> Compare). */
export const DEMO_FONTS = [
  "Roboto-Regular.ttf",
  "Inter.ttf",
  "NotoSans-Regular.ttf",
  "IBMPlexSans-Regular.ttf",
  "SourceSans3-Regular.ttf",
];

/** Целевой каталог рантайма и его данных. */
export function modDir(gameDir: string): string {
  return join(gameDir, MODS_FOLDER, MOD_FOLDER);
}

export function manifestPath(gameDir: string): string {
  return join(modDir(gameDir), MANIFEST_NAME);
}

export type DeployKind = "copy" | "build-dat" | "write-active-lang" | "write-manifest";

export interface DeployOp {
  /** Что делаем (человекочитаемо). */
  what: string;
  /** Источник; `null` — содержимое генерируется деплоем. */
  from: string | null;
  to: string;
  kind: DeployKind;
  optional: boolean;
  /** Источник существует прямо сейчас. */
  exists: boolean;
}

export interface DeployPlan {
  game: string;
  /** `<игра>/NeonTranslator` — куда идёт всё, кроме лоадера. */
  modDir: string;
  manifest: string;
  lang: string;
  /** `en`: нативный язык игры, словарь не нужен. */
  native: boolean;
  ops: DeployOp[];
  /** Нет обязательного источника — деплой невозможен. */
  missing: string[];
  /** Не блокирует, но о проблеме надо сказать. */
  warnings: string[];
}

/**
 * План деплоя: только чтение ФС, ничего не пишет. `--dry-run` печатает его
 * целиком, обычный запуск исполняет.
 */
export function planDeploy(
  gameDir: string,
  lang: string,
  repoRoot: string = REPO_ROOT,
): DeployPlan {
  const target = modDir(gameDir);
  const fontsTarget = join(target, FONT_SUBDIR);
  const manifest = manifestPath(gameDir);
  const native = lang === SOURCE_LANG;
  const ops: DeployOp[] = [];

  const add = (op: Omit<DeployOp, "exists">) => {
    ops.push({ ...op, exists: op.from ? existsSync(op.from) : true });
  };

  add({
    what: "рантайм (C# DLL)",
    from: join(repoRoot, "runtime", RUNTIME_DLL),
    to: join(target, RUNTIME_DLL),
    kind: "copy",
    optional: false,
  });
  add({
    what: `шрифт ${MAIN_FONT}`,
    from: join(repoRoot, "fonts", MAIN_FONT),
    to: join(fontsTarget, MAIN_FONT),
    kind: "copy",
    optional: false,
  });
  for (const font of CJK_FONTS) {
    add({
      what: `шрифт ${font} (CJK)`,
      from: join(repoRoot, "fonts", font),
      to: join(fontsTarget, font),
      kind: "copy",
      optional: true,
    });
  }
  for (const font of DEMO_FONTS) {
    add({
      what: `шрифт-кандидат ${font} (demo)`,
      from: join(repoRoot, "fonts", font),
      to: join(fontsTarget, font),
      kind: "copy",
      optional: true,
    });
  }
  add({
    what: `типографика ${TYPOGRAPHY}`,
    from: join(repoRoot, "fonts", TYPOGRAPHY),
    to: join(fontsTarget, TYPOGRAPHY),
    kind: "copy",
    optional: true,
  });
  // Необязательный, но нужный, если игра/мод вызывают прочие экспорты
  // dwmapi: прокси форвардит их сюда. Лежит в папке мода, чтобы в корне
  // оставался ровно один файл.
  add({
    what: "dwmapi_real.dll (цель форвардов прокси)",
    from: join(repoRoot, "dwmapi_real.dll"),
    to: join(target, "dwmapi_real.dll"),
    kind: "copy",
    optional: true,
  });
  if (!native) {
    add({
      what: `словарь patch_${lang}.dat`,
      from: join(repoRoot, "po", `${lang}.po`),
      to: join(target, `patch_${lang}.dat`),
      kind: "build-dat",
      optional: false,
    });
  }
  add({
    what: "active_lang.txt",
    from: null,
    to: join(target, "active_lang.txt"),
    kind: "write-active-lang",
    optional: false,
  });
  // Прокси нужен, чтобы рантайм вообще загружался. Копия в репо — артефакт
  // `build_proxy`; если её нет, но в игре прокси уже стоит — не перезаписываем.
  const repoProxy = join(repoRoot, "dwmapi.dll");
  const gameProxy = join(gameDir, "dwmapi.dll");
  const repoProxyExists = existsSync(repoProxy);
  const gameProxyExists = existsSync(gameProxy);
  add({
    what: "прокси-лоадер dwmapi.dll",
    from: repoProxy,
    to: gameProxy,
    kind: "copy",
    optional: !repoProxyExists && gameProxyExists,
  });
  add({
    what: MANIFEST_NAME,
    from: null,
    to: manifest,
    kind: "write-manifest",
    optional: false,
  });

  const missing = ops
    .filter((op) => !op.optional && !op.exists)
    .map((op) => `нет источника: ${op.what} (${op.from}) — ${hintFor(op, lang)}`);

  const warnings: string[] = [];
  for (const op of ops.filter((o) => o.optional && !o.exists)) {
    warnings.push(`необязательный файл отсутствует: ${op.what} (${op.from})`);
  }
  if (!repoProxyExists && gameProxyExists) {
    warnings.push(
      "копии dwmapi.dll в репозитории нет — в игре уже лежит прокси, не перезаписываю " +
        "(пересобрать: npm run build:proxy)",
    );
  }
  // Старый прокси грузит DLL по прежнему пути и молча ломает установку —
  // проверяем, что в бинаре есть имя текущего бренда (ASCII-строка класса mono).
  const proxyToCheck = repoProxyExists ? repoProxy : gameProxyExists ? gameProxy : null;
  if (proxyToCheck && !proxyHasBrand(proxyToCheck)) {
    warnings.push(
      `прокси ${proxyToCheck} собран под прежнюю раскладку (нет строки NeonTranslatorDX) — ` +
        "пересоберите: npm run build:proxy",
    );
  }
  // Предупреждаем о мусоре прежней раскладки, но не удаляем без --migrate.
  const legacy = planMigrate(gameDir);
  if (legacy.length) {
    warnings.push(
      `найдены артефакты прежней раскладки (${legacy.length}); удалить: --migrate ` +
        `(${legacy.map((f) => relative(gameDir, f.abs).replaceAll("\\", "/")).join(", ")})`,
    );
  }
  const legacyTranslations = join(gameDir, "translations");
  if (existsSync(legacyTranslations)) {
    warnings.push(
      `в папке игры осталось legacy-зеркало translations/ (YAML-раскладка; не удаляю — удалите вручную, если не нужно)`,
    );
  }

  return { game: gameDir, modDir: target, manifest, lang, native, ops, missing, warnings };
}

/** В бинаре прокси есть ASCII-строка текущего бренда (класс mono). */
function proxyHasBrand(path: string): boolean {
  try {
    return readFileSync(path).includes("NeonTranslatorDX");
  } catch {
    return false;
  }
}

/** Подсказка «чем починить» для отсутствующего источника. */
function hintFor(op: DeployOp, lang: string): string {
  if (op.what.includes("рантайм")) return "соберите: npm run build";
  if (op.what.includes("dwmapi.dll")) return "соберите: npm run build:proxy (нужен MSVC)";
  if (op.kind === "build-dat") return `нет po/${lang}.po — язык ещё не переведён`;
  return "проверьте репозиторий";
}

export interface ManifestFile {
  /** Путь относительно корня игры, всегда с `/`. */
  path: string;
  size: number;
  sha256: string;
}

export interface InstallManifest {
  version: 1;
  lang: string;
  installedAt: string;
  files: ManifestFile[];
}

export interface DeployResult {
  copied: string[];
  /** Собранный и установленный словарь (`null` в native-режиме и при uninstall). */
  dat: { staged: string; installed: string; rows: number } | null;
  warnings: string[];
  /** Записанный манифест. */
  manifest: InstallManifest;
}

/** sha256 файла (hex). */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Путь от корня игры с прямыми слэшами — формат манифеста. */
function manifestPathOf(gameDir: string, abs: string): string {
  return relative(gameDir, abs).replaceAll("\\", "/");
}

/**
 * Исполнить план. Бросает, если план неполон (обязательного источника нет).
 * Копирование и запись — атомарные (`.part` → rename): игра, читающая файл в
 * этот момент, не увидит половину словаря.
 */
export function executeDeploy(plan: DeployPlan, repoRoot: string = REPO_ROOT): DeployResult {
  if (plan.missing.length) {
    throw new Error(`деплой невозможен:\n  ${plan.missing.join("\n  ")}`);
  }

  const copied: string[] = [];
  let dat: DeployResult["dat"] = null;
  const files: ManifestFile[] = [];

  for (const op of plan.ops) {
    if (!op.exists) {
      // Необязательное: уже перечислено в warnings плана.
      continue;
    }
    if (op.kind === "copy" && op.from) {
      copyAtomic(op.from, op.to);
      copied.push(op.to);
      files.push(manifestEntry(plan.game, op.to));
      console.log(`  + ${op.what} -> ${op.to}`);
    } else if (op.kind === "build-dat") {
      const staged = join(repoRoot, "runtime", `patch_${plan.lang}.dat`);
      buildDatRust(plan.lang, repoRoot, staged);
      copyAtomic(staged, op.to);
      copied.push(op.to);
      files.push(manifestEntry(plan.game, op.to));
      const rows = readFileSync(staged, "utf8").split(/\r?\n/).filter(Boolean).length;
      dat = { staged, installed: op.to, rows };
      console.log(`  + patch_${plan.lang}.dat: ${rows} строк (rust-l10n po2dat)`);
      console.log(`    ${staged} -> ${op.to}`);
    } else if (op.kind === "write-active-lang") {
      writeAtomic(op.to, plan.lang);
      copied.push(op.to);
      files.push(manifestEntry(plan.game, op.to));
      console.log(`  + active_lang.txt = ${plan.lang}`);
    }
  }

  const manifest: InstallManifest = {
    version: 1,
    lang: plan.lang,
    installedAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeAtomic(plan.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  copied.push(plan.manifest);
  console.log(`  + ${MANIFEST_NAME}: ${manifest.files.length} файлов`);

  return { copied, dat, warnings: plan.warnings, manifest };
}

function manifestEntry(gameDir: string, abs: string): ManifestFile {
  const stat = statSync(abs);
  return {
    path: manifestPathOf(gameDir, abs),
    size: stat.size,
    sha256: sha256File(abs),
  };
}

/**
 * Собрать `.dat` рабочей реализацией (`rust-l10n po2dat`).
 *
 * Раньше словарь собирался TS-функцией в процессе; после миграции осталась
 * одна реализация — Rust, поэтому ошибка сборки обязана быть громкой: без
 * свежего `.dat` игра показала бы прошлый словарь.
 */
function buildDatRust(lang: string, repoRoot: string, out: string): void {
  const bin = l10nBinary(repoRoot) ?? l10nBinary();
  if (!bin) {
    throw new Error("rust-l10n не собран: `npm run l10n:build` (нужен для словаря .dat)");
  }
  const run = spawnSync(bin, ["po2dat", lang, "--root", repoRoot, "--out", out], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    throw new Error(
      `rust-l10n po2dat ${lang}: ${(run.stderr || "").trim() || "exit " + run.status}`,
    );
  }
}

/** Атомарная запись текста: `.part` → rename. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  try {
    writeFileSync(part, content, "utf8");
    renameSync(part, path);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

/** Атомарное копирование: `.part` → rename (источник обязан существовать). */
export function copyAtomic(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`нет источника для копирования: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  const part = `${to}.part`;
  try {
    copyFileSync(from, part);
    renameSync(part, to);
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(
      `не удалось скопировать ${from} -> ${to}: ${e instanceof Error ? e.message : String(e)}. ` +
        "Нужны права на запись в папку игры (или TCNN_GAME_DIR на копию установки).",
    );
  }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export interface UninstallTarget {
  path: string;
  abs: string;
  size: number;
  sha256: string;
  exists: boolean;
  /** Хэш на диске совпадает с манифестом (файл не правили руками). */
  matches: boolean;
}

export interface UninstallPlan {
  game: string;
  modDir: string;
  manifest: string;
  installManifest: InstallManifest | null;
  targets: UninstallTarget[];
  /** Почему установку не удалить (манифеста нет / битый). */
  error: string | null;
  warnings: string[];
}

/** Прочитать и проверить манифест (`null` — файла нет). */
export function readManifest(path: string): InstallManifest | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as InstallManifest;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`неизвестный формат манифеста: ${path}`);
  }
  return parsed;
}

/** Путь внутри корня игры (защита от `..` и абсолютных путей в манифесте). */
function insideGame(gameDir: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath)) return null;
  const root = resolve(gameDir);
  const abs = resolve(root, relPath);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

/** Файлы, которые рантайм создаёт сам в папке мода (их нет в манифесте). */
export const RUNTIME_ARTIFACTS = ["NeonTranslatorDX.log", "dump_GUIDictionary.json", "nolog.txt"];

export function planUninstall(gameDir: string): UninstallPlan {
  const target = modDir(gameDir);
  const manifest = manifestPath(gameDir);
  const warnings: string[] = [];

  let installManifest: InstallManifest | null = null;
  try {
    installManifest = readManifest(manifest);
  } catch (e) {
    return {
      game: gameDir,
      modDir: target,
      manifest,
      installManifest: null,
      targets: [],
      error: e instanceof Error ? e.message : String(e),
      warnings,
    };
  }
  if (!installManifest) {
    return {
      game: gameDir,
      modDir: target,
      manifest,
      installManifest: null,
      targets: [],
      error: `манифест не найден: ${manifest} (удалить вручную или поставьте заново и снимите через --uninstall)`,
      warnings,
    };
  }

  const targets: UninstallTarget[] = [];
  for (const file of installManifest.files) {
    const abs = insideGame(gameDir, file.path);
    if (!abs) {
      warnings.push(`пропущен опасный путь из манифеста: ${file.path}`);
      continue;
    }
    const exists = existsSync(abs);
    const matches = exists && sha256File(abs) === file.sha256;
    if (exists && !matches) {
      warnings.push(
        `файл изменён после установки — оставлю: ${file.path} ` +
          `(манифест ${file.sha256.slice(0, 12)}…, на диске ${sha256File(abs).slice(0, 12)}…)`,
      );
    }
    targets.push({ path: file.path, abs, size: file.size, sha256: file.sha256, exists, matches });
  }

  // Журнал/дамп рантайма создаются при запуске игры и в манифест не попадают,
  // но это наши файлы в нашей папке — удаляем их вместе с установкой. Сюда же
  // словари других языков и dwmapi_real.dll: после смены языка манифест знает
  // только последний patch_<lang>.dat, а папка должна опустеть.
  const seen = new Set(targets.map((t) => t.abs));
  const addOwn = (abs: string) => {
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    targets.push({
      path: manifestPathOf(gameDir, abs),
      abs,
      size: statSync(abs).size,
      sha256: "",
      exists: true,
      matches: true,
    });
  };
  for (const name of RUNTIME_ARTIFACTS) addOwn(join(target, name));
  addOwn(join(target, "dwmapi_real.dll"));
  for (const name of safeReaddir(target)) {
    if (/^patch_[a-z]{2}\.dat$/i.test(name)) addOwn(join(target, name));
  }
  return {
    game: gameDir,
    modDir: target,
    manifest,
    installManifest,
    targets,
    error: null,
    warnings,
  };
}

export interface UninstallResult {
  deleted: string[];
  kept: string[];
  removedDirs: string[];
  manifestDeleted: boolean;
}

/**
 * Удалить ровно поставленное: файлы из манифеста (только если хэш совпал),
 * сам манифест и опустевшие папки мода. Чужие файлы не трогаются.
 */
export function executeUninstall(plan: UninstallPlan): UninstallResult {
  if (plan.error) throw new Error(`удаление невозможно: ${plan.error}`);

  const deleted: string[] = [];
  const kept: string[] = [];

  for (const target of plan.targets) {
    if (!target.exists) {
      kept.push(target.path);
      console.log(`  · уже нет: ${target.path}`);
      continue;
    }
    if (!target.matches) {
      kept.push(target.path);
      console.log(`  ! изменён, оставлен: ${target.path}`);
      continue;
    }
    rmSync(target.abs, { force: true });
    deleted.push(target.path);
    console.log(`  - ${target.path}`);
  }

  let manifestDeleted = false;
  if (existsSync(plan.manifest)) {
    rmSync(plan.manifest, { force: true });
    manifestDeleted = true;
    console.log(`  - ${relative(plan.game, plan.manifest).replaceAll("\\", "/")}`);
  }

  // Сначала подпапки (fonts), затем папка мода. Только пустые: rmdir не
  // рекурсивен, поэтому чужие файлы внутри сохраняют папку.
  const removedDirs: string[] = [];
  for (const dir of [join(plan.modDir, FONT_SUBDIR), plan.modDir, join(plan.game, MODS_FOLDER)]) {
    if (!existsSync(dir)) continue;
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
      removedDirs.push(dir);
      console.log(`  - папка: ${dir}`);
    }
  }

  return { deleted, kept, removedDirs, manifestDeleted };
}

// ---------------------------------------------------------------------------
// Migrate (прежняя раскладка в Managed/ + мусор сборки)
// ---------------------------------------------------------------------------

export interface LegacyFile {
  path: string;
  abs: string;
}

/** Точные имена артефактов прежней раскладки в Managed/. */
const LEGACY_MANAGED_FILES = [
  "NeonTranslatorRuntime.dll",
  "NeonTranslatorDX.dll",
  "active_lang.txt",
  "NeonTranslator.log",
  "NeonTranslatorDX.log",
  "dump_GUIDictionary.json",
  MAIN_FONT,
  ...CJK_FONTS,
];

/** Имена, которые могли остаться в прежних папках `<игра>/<mod>/`. */
const LEGACY_OLD_MOD_FILES = [
  "NeonTranslatorRuntime.dll",
  "NeonTranslatorDX.dll",
  "NeonTranslator.log",
  "NeonTranslatorDX.log",
  "dump_GUIDictionary.json",
  "active_lang.txt",
  "install-manifest.json",
  "dwmapi_real.dll",
];

/** Мусор в корне игры от наших сборок (не файлы игры). */
const LEGACY_ROOT_FILES = ["dwmapi.exp", "dwmapi.lib", "dwmapi_real.dll", "nul"];

/**
 * Что осталось от прежней раскладки. Возвращает только существующие файлы;
 * ничего не удаляет. Чужие файлы (сборки Unity, сейвы) в список не попадают.
 */
export function planMigrate(gameDir: string): LegacyFile[] {
  const out: LegacyFile[] = [];
  const managed = join(gameDir, GAME_DATA_FOLDER, "Managed");
  const push = (abs: string) => {
    if (existsSync(abs) && !out.some((f) => f.abs === abs))
      out.push({ path: relative(gameDir, abs).replaceAll("\\", "/"), abs });
  };

  for (const name of LEGACY_MANAGED_FILES) push(join(managed, name));
  for (const name of safeReaddir(managed)) {
    if (/^patch_[a-z]{2}\.dat$/i.test(name)) push(join(managed, name));
  }
  for (const folder of LEGACY_MOD_FOLDERS) {
    const oldMod = join(gameDir, folder);
    for (const name of LEGACY_OLD_MOD_FILES) push(join(oldMod, name));
    for (const name of safeReaddir(oldMod)) {
      if (/^patch_[a-z]{2}\.dat$/i.test(name)) push(join(oldMod, name));
    }
    for (const name of safeReaddir(join(oldMod, FONT_SUBDIR))) {
      if (/\.(ttf|json)$/i.test(name)) push(join(oldMod, FONT_SUBDIR, name));
    }
  }
  for (const name of LEGACY_ROOT_FILES) push(join(gameDir, name));
  return out;
}

export interface MigrateResult {
  deleted: string[];
  failed: string[];
  removedDirs: string[];
}

export interface MigrateCopy {
  from: string;
  to: string;
}

/**
 * Что перенести из старых раскладок в новую папку перед удалением: словари,
 * шрифты, типографика и `dwmapi_real.dll`. Копируем только отсутствующее —
 * свежая сборка деплоя имеет приоритет. Не переносим рантайм/лог/дамп:
 * рантайм ставит деплой, лог и дамп создаст игра заново.
 */
export function planMigrateCopies(gameDir: string): MigrateCopy[] {
  const dest = modDir(gameDir);
  const destFonts = join(dest, FONT_SUBDIR);
  const sources = [
    join(gameDir, GAME_DATA_FOLDER, "Managed"),
    ...LEGACY_MOD_FOLDERS.map((folder) => join(gameDir, folder)),
  ];
  const copies: MigrateCopy[] = [];
  const add = (from: string, to: string) => {
    if (existsSync(from) && !existsSync(to) && !copies.some((c) => c.to === to)) {
      copies.push({ from, to });
    }
  };
  for (const src of sources) {
    for (const name of safeReaddir(src)) {
      if (/^patch_[a-z]{2}\.dat$/i.test(name)) add(join(src, name), join(dest, name));
    }
    for (const name of safeReaddir(join(src, FONT_SUBDIR))) {
      if (/\.(ttf|json)$/i.test(name)) add(join(src, FONT_SUBDIR, name), join(destFonts, name));
    }
    add(join(src, "dwmapi_real.dll"), join(dest, "dwmapi_real.dll"));
  }
  return copies;
}

/** Удалить артефакты прежней раскладки + опустевшие старые папки; всё — в логе. */
export function executeMigrate(files: LegacyFile[], gameDir: string): MigrateResult {
  const deleted: string[] = [];
  const failed: string[] = [];

  // Сначала переносим то, чего нет в новой папке (словари других языков и пр.).
  for (const copy of planMigrateCopies(gameDir)) {
    try {
      copyAtomic(copy.from, copy.to);
      console.log(`  + migrated: ${relative(gameDir, copy.to).replaceAll("\\", "/")}`);
    } catch (e) {
      failed.push(
        `${relative(gameDir, copy.from).replaceAll("\\", "/")}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  for (const file of files) {
    try {
      rmSync(file.abs, { force: true });
      deleted.push(file.path);
      console.log(`  - legacy: ${file.path}`);
    } catch (e) {
      failed.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Старые папки удаляются только если опустели: чужие файлы их сохранят.
  const removedDirs: string[] = [];
  for (const folder of LEGACY_MOD_FOLDERS) {
    const oldMod = join(gameDir, folder);
    for (const dir of [join(oldMod, FONT_SUBDIR), oldMod]) {
      if (!existsSync(dir)) continue;
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir);
        removedDirs.push(dir);
        console.log(`  - папка: ${relative(gameDir, dir).replaceAll("\\", "/")}`);
      }
    }
  }
  return { deleted, failed, removedDirs };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface DeployArgs {
  lang: string;
  dryRun: boolean;
  rebuild: boolean;
  proxy: boolean;
  uninstall: boolean;
  migrate: boolean;
  help: boolean;
}

/** Разбор аргументов CLI. */
export function parseArgs(argv: string[]): DeployArgs {
  const out: DeployArgs = {
    lang: "ru",
    dryRun: false,
    rebuild: false,
    proxy: false,
    uninstall: false,
    migrate: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--rebuild") out.rebuild = true;
    else if (arg === "--proxy") out.proxy = true;
    else if (arg === "--uninstall") out.uninstall = true;
    else if (arg === "--migrate") out.migrate = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--lang") {
      const value = argv[++i];
      if (!value) throw new Error("--lang без значения (нужен код языка, например ru)");
      out.lang = value;
    } else if (arg.startsWith("--lang=")) out.lang = arg.slice("--lang=".length);
    else throw new Error(`неизвестная опция: ${arg}`);
  }
  return out;
}

const USAGE = `Установка/удаление рантайм-переводчика в игре

  node .opencode/skills/deploy-translator/scripts/deploy.mts [опции]

  --lang <code>  язык из config/language-priority.mts (JSON-артефакт; по умолчанию ru);
                 "${SOURCE_LANG}" — native-режим (без словаря)
  --dry-run      показать план, ничего не писать
  --rebuild      перед деплоем собрать runtime/NeonTranslatorDX.dll
  --proxy        перед деплоем собрать dwmapi.dll (нужен MSVC)
  --uninstall    удалить ровно поставленное (файлы из манифеста + пустые папки)
  --migrate      после установки убрать артефакты прежней раскладки (Managed/, старые папки)
  --help, -h     эта справка

  Раскладка: <игра>/dwmapi.dll + <игра>/${MODS_FOLDER}/${MOD_FOLDER}/ (всё остальное).
  Игра: TCNN_GAME_DIR=<папка игры> (иначе автопоиск по Steam-библиотекам).
`;

function printPlan(plan: DeployPlan): void {
  console.log(`Игра:  ${plan.game}`);
  console.log(`Папка мода: ${plan.modDir}`);
  console.log(`Язык:  ${plan.lang}${plan.native ? " (native, без словаря)" : ""}`);
  console.log("\nПлан:");
  for (const op of plan.ops) {
    const mark = op.from === null ? "~" : op.exists ? "+" : op.optional ? "·" : "!";
    console.log(`  ${mark} ${op.what}`);
    if (op.from) console.log(`      ${op.from}`);
    console.log(`   -> ${op.to}`);
  }
  for (const w of plan.warnings) console.warn(`  ВНИМАНИЕ: ${w}`);
}

function printUninstallPlan(plan: UninstallPlan): void {
  console.log(`Игра:  ${plan.game}`);
  console.log(`Манифест: ${plan.manifest}`);
  if (plan.error) {
    console.error(`  ОШИБКА: ${plan.error}`);
  } else {
    console.log(`\nБудет удалено (${plan.targets.filter((t) => t.exists && t.matches).length}):`);
    for (const t of plan.targets) {
      const mark = !t.exists ? "·" : t.matches ? "-" : "!";
      console.log(`  ${mark} ${t.path}`);
    }
  }
  for (const w of plan.warnings) console.warn(`  ВНИМАНИЕ: ${w}`);
}

function main(argv: string[]): number {
  let args: DeployArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const game = resolveGame();
  if (game.error || !game.dir) {
    console.error(`ОШИБКА: ${game.error ?? "игра не найдена"}`);
    return 1;
  }
  const gameDir = game.dir;

  try {
    if (args.uninstall) {
      const plan = planUninstall(gameDir);
      printUninstallPlan(plan);
      if (plan.error) return 1;
      if (args.dryRun) {
        console.log("\nDry-run: ничего не удалено.");
        return 0;
      }
      console.log("\n==> Удаление");
      const result = executeUninstall(plan);
      console.log(
        `\nГотово: удалено файлов ${result.deleted.length}, оставлено ${result.kept.length}, ` +
          `папок ${result.removedDirs.length}`,
      );
      return 0;
    }

    const allowed = allLangs();
    if (!allowed.includes(args.lang)) {
      console.error(`язык "${args.lang}" не в приоритете. Доступны: ${allowed.join(", ")}`);
      return 1;
    }

    if (args.rebuild) {
      console.log("==> Сборка рантайма");
      buildRuntime({ gameDir });
    }
    if (args.proxy) {
      console.log("==> Сборка прокси");
      buildProxy({ gameDir });
    }

    const plan = planDeploy(gameDir, args.lang);
    printPlan(plan);
    if (plan.missing.length) {
      console.error("\nДеплой невозможен:");
      for (const m of plan.missing) console.error(`  - ${m}`);
      return 1;
    }
    if (args.dryRun) {
      if (args.migrate) {
        const copies = planMigrateCopies(gameDir);
        const deletes = planMigrate(gameDir);
        console.log(`\nMigrate: перенести ${copies.length}, удалить ${deletes.length}`);
        for (const c of copies) {
          console.log(`  + ${relative(gameDir, c.from).replaceAll("\\", "/")}`);
          console.log(` -> ${relative(gameDir, c.to).replaceAll("\\", "/")}`);
        }
        for (const f of deletes) console.log(`  - ${f.path}`);
      }
      console.log("\nDry-run: ничего не записано. Для деплоя уберите --dry-run.");
      return 0;
    }

    console.log("\n==> Раскладка");
    const result = executeDeploy(plan);
    const runtime = join(plan.modDir, RUNTIME_DLL);
    console.log(`\nГотово: файлов записано ${result.copied.length}`);
    console.log(`  DLL: ${runtime} (${statSize(runtime)} байт)`);
    if (result.dat) console.log(`  словарь: ${result.dat.installed} (${result.dat.rows} строк)`);
    console.log(`  язык: ${plan.lang}${plan.native ? " (native)" : ""}`);
    console.log(`  лоадер: ${join(gameDir, "dwmapi.dll")}`);
    console.log(`  манифест: ${plan.manifest}`);

    if (args.migrate) {
      const legacy = planMigrate(gameDir);
      console.log(`\n==> Migrate: артефактов прежней раскладки ${legacy.length}`);
      if (!legacy.length) console.log("  (нечего удалять)");
      const moved = executeMigrate(legacy, gameDir);
      console.log(`  удалено: ${moved.deleted.length}, ошибок: ${moved.failed.length}`);
      for (const f of moved.failed) console.error(`  ! ${f}`);
      if (moved.failed.length) return 1;
    }

    console.log(
      `\nПерезапустите игру; лог рантайма — ${join(plan.modDir, "NeonTranslatorDX.log")}`,
    );
    return 0;
  } catch (e) {
    console.error(`ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
