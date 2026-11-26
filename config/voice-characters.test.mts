/**
 * voice-characters.test.mts — стражи карты персонажей.
 *
 * Проверяем то, что легко сломать руками: покрытие спикеров POT (в обе стороны),
 * допустимые пол/озвучку, порядок приоритетов и существование выбранного рефа.
 * Аудио в git не лежит, поэтому отсутствие кандидатов на диске не ошибка —
 * проверяется только структура путей и `refs.chosen`, если он задан.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import {
  CHARACTERS,
  SPEAKER_TO_CHARACTER,
  type Gender,
  type VoicedInOriginal,
} from "./voice-characters.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const POT_PATH = join(REPO_ROOT, "po", "template.pot");

const GENDERS = new Set<Gender>(["female", "male", null]);
const VOICED = new Set<VoicedInOriginal>(["yes", "partial", "no"]);

function potSpeakers(): string[] {
  const entries = parsePo(readFileSync(POT_PATH, "utf8"));
  const names = new Set<string>();
  for (const entry of entries) {
    const match = /^speaker:(.+)$/.exec(entry.msgctxt);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

test("POT: каждый speaker покрыт картой, лишних ключей нет", () => {
  assert.deepEqual(
    Object.keys(SPEAKER_TO_CHARACTER).sort(),
    potSpeakers(),
    "SPEAKER_TO_CHARACTER должен ровно совпадать со спикерами po/template.pot",
  );
});

test("POT: непустые цели маппинга существуют в CHARACTERS", () => {
  for (const [speaker, target] of Object.entries(SPEAKER_TO_CHARACTER)) {
    if (target === null) continue;
    assert.ok(
      target in CHARACTERS,
      `спикер ${speaker} ссылается на неизвестного персонажа ${target}`,
    );
  }
});

test("CHARACTERS: имя, пол, озвучка и строки заполнены допустимо", () => {
  for (const [key, character] of Object.entries(CHARACTERS)) {
    assert.equal(character.name, key, "name должен совпадать с ключом");
    assert.ok(GENDERS.has(character.gender), `${key}: недопустимый пол`);
    assert.ok(VOICED.has(character.voicedInOriginal), `${key}: недопустимая озвучка`);
    assert.ok(character.role.trim().length > 0, `${key}: пустая роль`);
    assert.ok(character.description.trim().length > 40, `${key}: описание слишком куцее`);
    assert.ok(Number.isInteger(character.lines.total) && character.lines.total >= 0);
    assert.ok(Number.isInteger(character.lines.toVoice) && character.lines.toVoice >= 0);
  }
});

test("CHARACTERS: порядок ключей совпадает с приоритетом 1..N", () => {
  const priorities = Object.values(CHARACTERS).map((character) => character.priority);
  assert.deepEqual(
    priorities,
    priorities.map((_, index) => index + 1),
    "ключи идут в порядке приоритета без пропусков и повторов",
  );
});

test("refs: chosen либо null, либо существующий файл внутри voice-refs/", () => {
  for (const [key, character] of Object.entries(CHARACTERS)) {
    // Аннотация снимает литеральное сужение: сейчас все chosen = null, но тест
    // должен работать и когда владелец пропишет путь.
    const chosen = character.refs.chosen as string | null;
    if (chosen === null) continue;
    assert.ok(chosen.startsWith("voice-refs/"), `${key}: chosen вне voice-refs/`);
    assert.ok(existsSync(resolve(REPO_ROOT, chosen)), `${key}: файла ${chosen} нет`);
  }
});

test("refs: кандидаты уникальны, лежат в папке персонажа и ждут проверки", () => {
  for (const [key, character] of Object.entries(CHARACTERS)) {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const candidate of character.refs.candidates) {
      assert.ok(!ids.has(candidate.id), `${key}: повтор id ${candidate.id}`);
      assert.ok(!paths.has(candidate.path), `${key}: повтор пути ${candidate.path}`);
      ids.add(candidate.id);
      paths.add(candidate.path);

      const prefix = `voice-refs/${key}/candidates/`;
      assert.ok(candidate.path.startsWith(prefix), `${key}: ${candidate.path} вне ${prefix}`);
      assert.ok(
        candidate.manualCheck === "pending" ||
          candidate.manualCheck === "passed" ||
          candidate.manualCheck === "failed",
        `${key}: недопустимый manualCheck у ${candidate.id}`,
      );
    }
  }
});
