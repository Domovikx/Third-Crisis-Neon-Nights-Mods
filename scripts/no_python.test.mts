/**
 * Страж: в проекте не должно быть Python.
 *
 * Решение владельца и куратора (2026-11-22): стек проекта — TypeScript и Rust; Python запрещён
 * (AR/AGENTS.md, «Языки»). Миграция завершена, и это не должно откатиться случайно: один
 * забытый `.py` в скилле снова потянет за собой зависимости, CI-джоб и «временный» остров.
 *
 * Тест намеренно строгий: ловит и файлы, и упоминания в CI/конфигах, и мусор байткода.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules", "tmp", "dist", "target"]);

/** Рекурсивный обход без захода в тяжёлые каталоги. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test("страж: в репозитории нет Python-файлов", () => {
  const files = walk(REPO);
  const py = files.filter(
    (f) => /\.(py|pyc|pyo)$/.test(f) || /(^|[\\/])__pycache__([\\/]|$)/.test(f),
  );
  assert.deepEqual(py, [], "найдены Python-файлы — миграция откатилась");
});

test("страж: нет Python-манифестов зависимостей", () => {
  const files = walk(REPO).map((f) => f.replace(/\\/g, "/"));
  const bad = files.filter((f) =>
    /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py|Pipfile|poetry\.lock)$/.test(f),
  );
  assert.deepEqual(bad, [], "найдены Python-манифесты");
});

test("страж: CI и package.json не запускают Python", () => {
  const checked = [
    ".github/workflows/ci.yml",
    ".github/workflows/pages.yml",
    "package.json",
    "opencode.json",
  ];
  for (const rel of checked) {
    let text: string;
    try {
      text = readFileSync(join(REPO, rel), "utf8");
    } catch {
      continue;
    }
    assert.ok(
      !/\bpython3?\b|\bpip\s+install\b|\bpytest\b/.test(text),
      `${rel} всё ещё упоминает Python`,
    );
  }
});
