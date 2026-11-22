/**
 * dump_parity.mts — харнесс паритета TS-дампера против Python-эталона (UnityPy).
 *
 * Зачем: контракт дампера — JSONL, который ниже по течению читают
 * `inventory.mts`/`potgen.mts`. Пока стадии 3–4 не готовы, сверяется то, что
 * уже реализовано (стадии 1–2): список entry бандлов и таблица объектов
 * `(path_id, typeID)` каждого SerializedFile.
 *
 * Два режима:
 *
 *   structure (по умолчанию)
 *     Запускает UnityPy-пробу на тех же файлах, что и `dump_assets.mts
 *     structure --json`, и сравнивает entry + объекты. Python-дампер
 *     (`dump_assets.py`) не запускается целиком: он пишет 319 МБ и ходит по
 *     всем файлам, а нам нужен тот же РАЗБОР на выбранном наборе. Пробу делает
 *     тот же UnityPy, что и в эталоне.
 *
 *   --jsonl --expect <dir> [--actual <dir>]
 *     Построчное сравнение двух каталогов дампа с нормализацией порядка ключей
 *     (готово к стадии 4: `--expect tmp/dump-py`, `--actual tmp/dump-ts`).
 *
 * CLI:
 *   node scripts/dump_parity.mts [--files a,b,c | --all]
 *   node scripts/dump_parity.mts --jsonl --expect <dir> [--actual <dir>]
 *
 * Выход: 0 — всё совпало, 1 — есть расхождения, 2 — не смог запуститься.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";

import { checkGameDir, findGameDir } from "../scripts/game_dir.mts";
import {
  describeAssetFile,
  discoverGameFiles,
  type StructureReport,
} from "../.opencode/skills/dump-assets/scripts/dump_assets.mts";

/** Проба UnityPy: тот же разбор, что делает Python-дампер, но без записи JSONL. */
const PYTHON_PROBE = String.raw`
import json, os, sys
import UnityPy
from UnityPy.files.BundleFile import BundleFile

_entries = {}
_orig_read_files = BundleFile.read_files

def _patched_read_files(self, reader, files):
    _entries[id(self)] = [
        {"path": n.path, "offset": n.offset, "size": n.size} for n in files
    ]
    return _orig_read_files(self, reader, files)

BundleFile.read_files = _patched_read_files


def collect(f):
    out = []
    if getattr(f, "objects", None) is not None and hasattr(f, "header"):
        out.append(f)
    inner = getattr(f, "files", None)
    if inner:
        for sub in inner.values():
            out.extend(collect(sub))
    return out


for path in sys.argv[1:]:
    name = os.path.basename(path)
    try:
        env = UnityPy.load(path)
        files = []
        entries = []
        is_bundle = False
        for f in env.files.values():
            if id(f) in _entries:
                is_bundle = True
                entries.extend(_entries[id(f)])
            for sf in collect(f):
                files.append(
                    {
                        "name": sf.name,
                        "unityVersion": sf.unity_version,
                        "headerVersion": sf.header.version,
                        "typeTreeEnabled": bool(sf._enable_type_tree),
                        "objects": [[str(o.path_id), o.type_id] for o in sf.objects.values()],
                    }
                )
        print(json.dumps({
            "file": name,
            "path": path,
            "kind": "unityfs" if is_bundle else "serialized",
            "entries": entries,
            "files": files,
        }, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"file": name, "path": path, "error": str(exc)}, ensure_ascii=False))
`;

interface PythonEntry {
  path: string;
  offset: number;
  size: number;
}

interface PythonFile {
  name: string;
  unityVersion: string;
  headerVersion: number;
  typeTreeEnabled: boolean;
  objects: Array<[string, number]>;
}

interface PythonReport {
  file: string;
  path: string;
  kind?: "unityfs" | "serialized";
  entries?: PythonEntry[];
  files?: PythonFile[];
  error?: string;
}

interface Difference {
  file: string;
  message: string;
}

/** Достать JSON-строки из stdout пробы, игнорируя болтовню UnityPy. */
function parseProbeOutput(stdout: string): PythonReport[] {
  const reports: PythonReport[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      reports.push(JSON.parse(trimmed) as PythonReport);
    } catch {
      // не наша строка — пропускаем
    }
  }
  return reports;
}

function firstDiff(expected: unknown, actual: unknown, label: string): string | null {
  const a = JSON.stringify(expected);
  const b = JSON.stringify(actual);
  if (a === b) return null;
  return `${label}: Python=${a} TS=${b}`;
}

function compareOne(py: PythonReport, ts: StructureReport): Difference | null {
  const file = ts.file;
  if (py.error) {
    return { file, message: `Python не разобрал файл: ${py.error}` };
  }
  if (ts.kind !== "unityfs" && ts.kind !== "serialized") {
    return { file, message: `TS не увидел Unity-файл (kind=${ts.kind})` };
  }
  if (py.kind !== ts.kind) {
    return { file, message: `тип файла: Python=${py.kind} TS=${ts.kind}` };
  }

  const pyEntries = py.entries ?? [];
  if (pyEntries.length !== ts.entries.length) {
    return {
      file,
      message: `entry: Python=${pyEntries.length} TS=${ts.entries.length}`,
    };
  }
  for (let i = 0; i < pyEntries.length; i++) {
    const diff = firstDiff(
      [pyEntries[i].path, pyEntries[i].offset, pyEntries[i].size],
      [ts.entries[i].path, ts.entries[i].offset, ts.entries[i].size],
      `entry[${i}]`,
    );
    if (diff) return { file, message: diff };
  }

  const pyFiles = py.files ?? [];
  if (pyFiles.length !== ts.files.length) {
    return { file, message: `SerializedFile: Python=${pyFiles.length} TS=${ts.files.length}` };
  }
  for (let i = 0; i < pyFiles.length; i++) {
    const pf = pyFiles[i];
    const tf = ts.files[i];
    if (pf.name !== tf.name) {
      return { file, message: `файл[${i}].name: Python=${pf.name} TS=${tf.name}` };
    }
    if (pf.unityVersion !== tf.unityVersion) {
      return {
        file,
        message: `файл[${i}].unityVersion: Python=${pf.unityVersion} TS=${tf.unityVersion}`,
      };
    }
    if (pf.headerVersion !== tf.headerVersion) {
      return {
        file,
        message: `файл[${i}].headerVersion: Python=${pf.headerVersion} TS=${tf.headerVersion}`,
      };
    }
    if (pf.typeTreeEnabled !== tf.typeTreeEnabled) {
      return {
        file,
        message: `файл[${i}].typeTreeEnabled: Python=${pf.typeTreeEnabled} TS=${tf.typeTreeEnabled}`,
      };
    }
    const pyObjects = pf.objects;
    const tsObjects = tf.objects.map((o) => [o.pathId, o.typeId]);
    if (pyObjects.length !== tsObjects.length) {
      return {
        file,
        message: `файл[${i}] (${pf.name}) объектов: Python=${pyObjects.length} TS=${tsObjects.length}`,
      };
    }
    for (let j = 0; j < pyObjects.length; j++) {
      if (pyObjects[j][0] !== tsObjects[j][0] || pyObjects[j][1] !== tsObjects[j][1]) {
        return {
          file,
          message:
            `файл[${i}] объект[${j}]: Python=(${pyObjects[j][0]},${pyObjects[j][1]}) ` +
            `TS=(${tsObjects[j][0]},${tsObjects[j][1]})`,
        };
      }
    }
  }
  return null;
}

function runStructureParity(targets: Array<{ name: string; path: string }>): number {
  const python = process.env.TCNN_PYTHON ?? "python";
  console.log(`Паритет структуры: ${targets.length} файл(ов)`);
  for (const t of targets) console.log(`  - ${t.name}: ${t.path}`);

  const pyRun = spawnSync(python, ["-c", PYTHON_PROBE, ...targets.map((t) => t.path)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (pyRun.error || pyRun.status !== 0) {
    console.error("Python-проба не запустилась:", pyRun.error?.message ?? pyRun.stderr);
    return 2;
  }
  const pyReports = new Map(parseProbeOutput(pyRun.stdout).map((r) => [basename(r.path), r]));

  const differences: Difference[] = [];
  const checked: string[] = [];
  for (const t of targets) {
    const py = pyReports.get(basename(t.path));
    if (!py) {
      differences.push({ file: t.name, message: "Python-проба не вернула строку по файлу" });
      continue;
    }
    if (!existsSync(t.path)) {
      differences.push({ file: t.name, message: "файл не найден" });
      continue;
    }
    const ts = describeAssetFile(t.name, t.path, new Uint8Array(readFileSync(t.path)), true);
    const diff = compareOne(py, ts);
    if (diff) differences.push(diff);
    else checked.push(t.name);
  }

  for (const name of checked) console.log(`OK   ${name}`);
  for (const d of differences) console.log(`DIFF ${d.file}: ${d.message}`);
  console.log(
    `\nИтог: совпало ${checked.length}, разошлось ${differences.length} (всего ${targets.length})`,
  );
  return differences.length === 0 ? 0 : 1;
}

/** Нормализация JSON: сортировка ключей рекурсивно (порядок полей не контракт). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonical(src[key]);
    return out;
  }
  return value;
}

function compareJsonlDirs(expectDir: string, actualDir: string): number {
  const files = readdirSync(expectDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  if (files.length === 0) {
    console.error(`В ${expectDir} нет *.jsonl — сравнивать нечего.`);
    return 2;
  }
  let differing = 0;
  for (const name of files) {
    const actualPath = join(actualDir, name);
    if (!existsSync(actualPath)) {
      console.log(`DIFF ${name}: нет в ${actualDir}`);
      differing += 1;
      continue;
    }
    const expected = readFileSync(join(expectDir, name), "utf8").split(/\r?\n/).filter(Boolean);
    const actual = readFileSync(actualPath, "utf8").split(/\r?\n/).filter(Boolean);
    if (expected.length !== actual.length) {
      console.log(`DIFF ${name}: строк Python=${expected.length} TS=${actual.length}`);
      differing += 1;
      continue;
    }
    let shown = 0;
    for (let i = 0; i < expected.length; i++) {
      let a: unknown;
      let b: unknown;
      try {
        a = canonical(JSON.parse(expected[i]));
        b = canonical(JSON.parse(actual[i]));
      } catch {
        console.log(`DIFF ${name}:${i + 1}: строка не JSON`);
        shown += 1;
        if (shown >= 5) break;
        continue;
      }
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        console.log(
          `DIFF ${name}:${i + 1}\n  Python: ${JSON.stringify(a)}\n  TS    : ${JSON.stringify(b)}`,
        );
        shown += 1;
        if (shown >= 5) break;
      }
    }
    if (shown === 0) console.log(`OK   ${name} (${expected.length} строк)`);
    else differing += 1;
  }
  console.log(`\nИтог: файлов ${files.length}, разошлось ${differing}`);
  return differing === 0 ? 0 : 1;
}

function argValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
  }
  return null;
}

/** Набор по умолчанию: маленький ассет, средний ассет и первый бандл. */
function defaultTargets(): Array<{ name: string; path: string }> {
  const found = findGameDir();
  if (!checkGameDir(found).ok) return [];
  const discovered = discoverGameFiles(found as string);
  const pick = (name: string) => discovered.find((d) => d.name === name);
  const targets: Array<{ name: string; path: string }> = [];
  for (const name of ["level0", "sharedassets1"]) {
    const item = pick(name);
    if (item) targets.push(item);
  }
  const bundle = discovered.find((d) => d.name.startsWith("bundle_"));
  if (bundle) targets.push(bundle);
  return targets;
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      [
        "node scripts/dump_parity.mts [--files a,b,c | --all]",
        "node scripts/dump_parity.mts --jsonl --expect <dir> [--actual <dir>]",
        "",
        "structure — сверка entry и таблицы объектов с UnityPy (стадии 1–2);",
        "jsonl     — построчная сверка каталогов дампа (стадия 4).",
      ].join("\n"),
    );
    return 0;
  }

  if (argv.includes("--jsonl")) {
    const expectDir = argValue(argv, "--expect");
    const actualDir = argValue(argv, "--actual");
    if (!expectDir || !actualDir) {
      console.error(
        "--jsonl требует --expect <каталог Python-дампа> и --actual <каталог TS-дампа>\n" +
          "(стадии 3–4 ещё не реализованы — каталог TS-дампа появится позже)",
      );
      return 2;
    }
    return compareJsonlDirs(resolve(expectDir), resolve(actualDir));
  }

  let targets: Array<{ name: string; path: string }>;
  const filesArg = argValue(argv, "--files");
  if (filesArg) {
    const found = findGameDir();
    const discovered = found ? discoverGameFiles(found) : [];
    targets = filesArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => {
        const base = item.split(/[\\/]/).pop() ?? item;
        const match =
          discovered.find((d) => d.name === item) ??
          discovered.find((d) => basename(d.path) === base);
        return { name: match?.name ?? base, path: match?.path ?? resolve(item) };
      });
  } else {
    targets = defaultTargets();
    if (targets.length === 0) {
      console.error("Игра не найдена (TCNN_GAME_DIR) и --files не задан.");
      return 2;
    }
    console.log("Набор по умолчанию (--files не задан): level0, sharedassets1, первый бандл");
  }
  return runStructureParity(targets);
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
