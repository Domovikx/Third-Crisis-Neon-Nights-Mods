/**
 * Тесты пакетного перевода. Сеть — только локальный фейковый
 * OpenAI-сервер на `node:http` (никакой реальной LLM).
 *
 * Паритет с `translate_local.test.py`: триаж без модели, разбор ответа,
 * валидация (БЕЗ проверки длины), атомарная запись po, склейка промпта из
 * `translates/`. Плюс то, чего в Python-тестах не было: полный прогон
 * очереди (перевёл / встал по PAUSE / продолжил с места).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  applyMsgstrInPlace,
  buildGlossary,
  buildSystemPrompt,
  batchPrompt,
  entryKey,
  loadCore,
  loadLangSkill,
  loadSkillRules,
  keepsNumbering,
  keepsTokens,
  buildSceneContext,
  parseResponse,
  runQueue,
  speakerOf,
  splitForCtx,
  stripSpeakerLeak,
  triage,
  validate,
} from "../scripts/translate_local.mts";
import type { PoEntry } from "../../extract-text/scripts/po_file.mts";

const REPO = resolve(import.meta.dirname, "../../../..");

const entry = (msgid: string, ctxt = "ui", msgstr = ""): PoEntry => ({
  msgid,
  msgctxt: ctxt,
  msgstr,
  refs: [],
  comments: [],
  flags: [],
  translator: [],
});

// --- фейковый OpenAI-сервер ------------------------------------------------

interface FakeLlm {
  url: string;
  /** Тексты user-промптов всех запросов (в порядке поступления). */
  requests: string[];
  close: () => Promise<void>;
}

/** Ответ фейка: строка ответа модели или HTTP-статус для проверки обрыва. */
type Respond = (lines: string[], callIndex: number) => string | { status: number };

async function fakeLlm(respond: Respond): Promise<FakeLlm> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const payload = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const user = payload.messages[payload.messages.length - 1].content;
      requests.push(user);
      // Строки промпта: "1. текст (speaker: X)" — заголовок отбрасываем.
      const lines = user
        .split("\n")
        .slice(1)
        .map((l) => l.replace(/^\d+\.\s*/, "").replace(/\s*\(speaker:[^)]*\)$/, ""));
      const out = respond(lines, requests.length - 1);
      if (typeof out === "object") {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: out } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}

const echo = (lines: string[]): string => lines.map((t, i) => `${i + 1}. ПЕРЕВОД: ${t}`).join("\n");

// --- фикстуры ---------------------------------------------------------------

interface Work {
  root: string;
  poPath: string;
  tmpDir: string;
}

/** Временный «репозиторий»: только po/<lang>.po (translates/ нет — фолбэк). */
function work(entries: PoEntry[], lang = "ru"): Work {
  const root = mkdtempSync(join(REPO, "tmp", "tl-"));
  mkdirSync(join(root, "po"), { recursive: true });
  const poPath = join(root, "po", `${lang}.po`);
  const body = entries
    .map((e) => {
      const ctxt = e.msgctxt ? `msgctxt "${e.msgctxt}"\n` : "";
      return `${ctxt}msgid "${e.msgid}"\nmsgstr "${e.msgstr}"\n`;
    })
    .join("\n");
  writeFileSync(poPath, body, "utf8");
  return { root, poPath, tmpDir: join(root, "tmp", "translate-local") };
}

function cleanup(w: Work): void {
  rmSync(w.root, { recursive: true, force: true });
}

/** Прочитать msgstr по ключу из записанного po. */
function msgstrOf(path: string, text: string): string | undefined {
  const src = readFileSync(path, "utf8");
  const re = new RegExp(`msgid "${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\nmsgstr "(.*)"`);
  return re.exec(src)?.[1];
}

// --- триаж без модели (паритет с Python-тестами) --------------------------

test("triage: код/мусор копируются, живой текст уходит в модель", () => {
  assert.equal(triage("RestrictSaves", "ru"), "RestrictSaves", "camel copy");
  assert.equal(triage("...", "ru"), "...", "punct copy");
  assert.equal(triage("v 0.4.0-a17", "ru"), "v 0.4.0-a17", "version copy");
  assert.equal(triage("Привет", "ru"), "Привет", "already ru copy");
  assert.equal(triage("", "ru"), "", "empty copy");
  assert.equal(triage("New Game", "ru"), null, "UI to LLM");
  assert.equal(triage("OK", "ru"), "OK", "code token copy");
  assert.equal(triage("Off", "ru"), null, "Off to LLM");
  assert.equal(triage("? 8fA", "ru"), "? 8fA", "prefixed garbage copy");
  assert.equal(triage("-#YA", "ru"), "-#YA", "hash token copy");
  assert.equal(triage("- later...", "ru"), null, "dashed phrase to LLM");
  assert.equal(
    triage("537d8372-b666-49a2-890c-9597ad5e94a1", "ru"),
    "537d8372-b666-49a2-890c-9597ad5e94a1",
  );
  assert.equal(triage("Yesss...!~", "ru"), null, "moan to LLM");
  assert.equal(triage("handlesOut must be same", "ru"), null, "mixed to LLM");
  // уже русский текст не копируем для не-ru языков
  assert.equal(triage("Привет", "de"), null);
});

test("buildGlossary: канон speaker-name идёт первым и попадает целиком", () => {
  const es = [
    entry("Some Text", "ui", ""),
    entry("Rosie", "speaker-name", "Рози"),
    entry("Zoey", "speaker-name", "Зои"),
    entry("Anna", "speaker-name", "Анна"),
    entry("Extra", "ui", "Лишнее"),
  ];
  const g = buildGlossary(es);
  assert.ok(g.startsWith("Rosie=Рози; Zoey=Зои; Anna=Анна"), g);
});

test("keepsNumbering: номер строки промпта не протекает в перевод", () => {
  assert.equal(keepsNumbering("But how are you...?", "2. Но как ты...?"), false);
  assert.equal(keepsNumbering("But how are you...?", "Но как ты...?"), true);
  assert.equal(keepsNumbering("But how are you...?", "1) Но как ты?"), false);
  // Оригинал сам начинается с числа — тогда префикс законен.
  assert.equal(keepsNumbering("2. Something", "2. Что-то"), true);
  assert.equal(validate("But how are you...?", "2. Но как ты...?", "ru"), "numbering");
});

test("keepsTokens: токены подстановки не переводятся и не теряются", () => {
  assert.ok(
    keepsTokens("#TakenFromInventoryText# #ItemName#.", "#TakenFromInventoryText# #ItemName#."),
  );
  assert.ok(
    keepsTokens("#TakenFromInventoryText# #ItemName#.", "#TakenFromInventoryText#: #ItemName#."),
    "текст между токенами можно менять",
  );
  assert.ok(!keepsTokens("#ItemName#.", "#ИмяПредмета#."), "переименованный токен — отказ");
  assert.ok(!keepsTokens("#ItemName#.", "."), "потерянный токен — отказ");
  assert.ok(keepsTokens("Hi %s, you have {Count} items", "Привет, %s, у тебя {Count} предметов"));
  assert.ok(!keepsTokens("Hi %s", "Привет, %d"), "другой printf-тип — отказ");
  assert.equal(validate("#ItemName#.", "#ИмяПредмета#.", "ru"), "token");
});

test("batchPrompt: контекст сцены идёт отдельным блоком и не мешает нумерации", () => {
  const items = [entry("Aww shucks~! Well, come on in!"), entry("Second line")];
  const ctx = new Map([
    ["Aww shucks~! Well, come on in!", ["prev: [—] Oh- Wow! The bed!", "next: [—] Y-You sure?"]],
  ]);
  const withCtx = batchPrompt(items, ctx);
  assert.match(withCtx, /^Context for meaning/);
  assert.match(withCtx, /\/\/ 1 prev: \[—\] Oh- Wow! The bed!/);
  assert.match(withCtx, /\/\/ 1 next: \[—\] Y-You sure\?/);
  assert.match(withCtx, /1\. Aww shucks~! Well, come on in!/);
  assert.doesNotMatch(batchPrompt(items), /Context for meaning/, "без карты — прежний промпт");
});

test("buildSceneContext: соседи берутся из диалогового объекта, порядок по idx", async () => {
  // Своя мини-сцена: три реплики в одном объекте, проверяем и prev, и next.
  const dir = join(REPO, "tmp", "ctx-fixture-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "level_test.jsonl"),
    `${JSON.stringify({
      asset: "level_test",
      path_id: 1,
      type: "MonoBehaviour",
      dialogues: [
        { speaker: "Zoey", text: "One line", rich_text: "" },
        { speaker: "", text: "Two line", rich_text: "" },
        { speaker: "Sarah", text: "Three line", rich_text: "" },
      ],
    })}
`,
    "utf8",
  );
  const map = await buildSceneContext(dir);
  assert.deepEqual(map.get("Two line"), ["prev: [Zoey] One line", "next: [Sarah] Three line"]);
  assert.deepEqual(map.get("One line"), ["next: [—] Two line"]);
  rmSync(dir, { recursive: true, force: true });
});

test("parseResponse: ровно n строк в формате N., а для n=1 — и без нумерации", () => {
  assert.deepEqual(parseResponse("1. Да\n2. Нет\n", 2), ["Да", "Нет"]);
  assert.deepEqual(parseResponse("1) Да\n2) Нет\n", 2), ["Да", "Нет"]);
  assert.equal(parseResponse("1. Да\n", 2), null, "count mismatch");
  // n=1: модель часто отвечает без номера (19 ретраев на 5 строк, 2026-11-23).
  assert.deepEqual(parseResponse("Привет", 1), ["Привет"], "одна строка без номера");
  assert.deepEqual(parseResponse("1. Привет", 1), ["Привет"]);
  assert.deepEqual(parseResponse("N. Привет", 1), ["Привет"], "эхо формата");
  assert.equal(
    parseResponse("Вот перевод:\nПривет", 1),
    null,
    "две строки — это преамбула, нужен ретрай",
  );
  assert.equal(parseResponse("", 1), null, "пустой ответ");
});

test("validate: теги и RU-кластеры; длина НЕ проверяется", () => {
  assert.equal(validate("Hi", "Привет", "ru"), null);
  assert.equal(validate("Hi", "", "ru"), "empty");
  assert.equal(validate("<color=x>Hi</color>", "Привет", "ru"), "tag imbalance");
  assert.equal(validate("Ahhh", "Фхааа", "ru"), "banned cluster");
  assert.equal(validate("Hi", "Привет, ".repeat(10), "ru"), null, "длина не критерий");
  assert.equal(validate("Ahhh", "Фхааа", "de"), null, "запрет только для ru");
});

test("stripSpeakerLeak: эхо тега спикера срезается", () => {
  assert.deepEqual(stripSpeakerLeak("Привет (speaker: Leona)"), { clean: "Привет", leaked: true });
  assert.deepEqual(stripSpeakerLeak("Привет"), { clean: "Привет", leaked: false });
});

test("splitForCtx: длинная пачка режется по бюджету, короткая — нет", () => {
  const big = Array.from({ length: 6 }, () => entry("word ".repeat(200)));
  const parts = splitForCtx("s", big, 1200, 1900);
  assert.ok(parts.length > 1);
  assert.equal(
    parts.reduce((n, p) => n + p.length, 0),
    6,
    "ничего не потеряно",
  );
  const one = splitForCtx("s", big.slice(0, 1), 1200, 1900);
  assert.deepEqual(one, [big.slice(0, 1)]);
});

test("ключи, спикеры и промпты", () => {
  assert.equal(entryKey(entry("Hi", "speaker:Leona")), "speaker:Leona\u0000Hi");
  assert.equal(speakerOf(entry("x", "speaker:Leona")), "Leona");
  assert.equal(speakerOf(entry("x", "speaker:???")), null);
  assert.equal(speakerOf(entry("x", "ui")), null);
  assert.ok(batchPrompt([entry("Hi", "speaker:Leona")]).includes("1. Hi (speaker: Leona)"));
  assert.ok(batchPrompt([entry("Hi")]).startsWith("Translate each line"));
  const sp = buildSystemPrompt("de", "German", "Zoey=Zoe", REPO);
  assert.ok(sp.includes("German") && sp.includes("Zoey=Zoe"));
  assert.ok(!sp.replace(/\{n\}/g, "3").includes("{n}"), "плейсхолдер {n} подставляется");
});

test("правила из translates/ читаются с диска (единый источник)", () => {
  const { sfx, glossary } = loadSkillRules(REPO);
  assert.ok(sfx.length > 200 && sfx.includes("Аах"), "таблица SFX из ru.md");
  assert.ok(glossary.includes("Zoey") && glossary.includes("Зои"), "глоссарий из ru.md");
  const prompt = buildSystemPrompt("ru", "Russian", "", REPO);
  assert.ok(prompt.includes("Аах") && prompt.includes("Зои"), "system prompt берёт таблицы");
  assert.equal(loadLangSkill("xx", REPO), "", "нет файла языка — generic");
  assert.ok(loadLangSkill("de", REPO).includes("du with lovers"));
  assert.ok(loadCore(REPO).includes("Единица перевода"), "ядро из core.md");
  assert.ok(buildGlossary([entry("Zoey", "ui", "Зои")]).includes("Zoey=Зои"));
});

test("applyMsgstrInPlace: пишет только пустое, остальное не трогает, атомарно", () => {
  const root = mkdtempSync(join(REPO, "tmp", "tl-inplace-"));
  try {
    const p = join(root, "t.po");
    writeFileSync(
      p,
      '#: [dlg:1#0]\nmsgctxt "ui"\nmsgid "Hi"\nmsgstr ""\n\n' +
        '#: [dlg:2#0]\nmsgctxt "ui"\nmsgid "Bye"\nmsgstr "Пока"\n',
      "utf8",
    );
    applyMsgstrInPlace(p, new Map([["ui\u0000Hi", "Привет"]]));
    const got = readFileSync(p, "utf8");
    assert.ok(got.includes('msgid "Hi"\nmsgstr "Привет"'), "записан пустой");
    assert.ok(got.includes('msgid "Bye"\nmsgstr "Пока"'), "заполненный цел");
    assert.equal(got.split("msgstr").length - 1, 2, "без дублей");
    assert.equal(existsSync(`${p}.part`), false, "после записи .part нет");

    // заполненная запись не перезаписывается даже при явном апдейте
    applyMsgstrInPlace(p, new Map([["ui\u0000Bye", "Пока-2"]]));
    assert.ok(readFileSync(p, "utf8").includes('msgid "Bye"\nmsgstr "Пока"'), "filled kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyMsgstrInPlace: одинаковый текст в разных контекстах — свои переводы", () => {
  const root = mkdtempSync(join(REPO, "tmp", "tl-ctx-"));
  try {
    const p = join(root, "t.po");
    writeFileSync(
      p,
      'msgctxt "speaker:Leona"\nmsgid "Yo"\nmsgstr "Йо (ж.)"\n\n' +
        'msgctxt "speaker:???"\nmsgid "Yo"\nmsgstr ""\n',
      "utf8",
    );
    applyMsgstrInPlace(p, new Map([["speaker:???\u0000Yo", "Йо"]]));
    const got = readFileSync(p, "utf8");
    assert.ok(got.includes('msgstr "Йо (ж.)"'), "другой контекст цел");
    assert.equal(got.split('msgstr "Йо"').length - 1, 1, "пустой заполнен один раз");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- полный прогон на фейковом сервере -------------------------------------

test("runQueue: переводит пустые, триажит мусор, заполненное не трогает", async () => {
  const w = work([
    entry("Hello there friend", "speaker:Zoey"),
    entry("Good morning to you", "speaker:Zoey", "Доброе утро"),
    entry("See you tomorrow", "speaker:Zoey"),
    entry("RestrictSaves", "ui"),
  ]);
  const llm = await fakeLlm((lines) => echo(lines));
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 2,
      log: () => {},
    });
    assert.equal(s.done, 2, "две живые строки переведены");
    assert.equal(s.triaged, 1, "код скопирован без модели");
    assert.equal(s.failed, 0);
    assert.equal(llm.requests.length, 1, "одна пачка: вторая — только триаж");
    assert.equal(msgstrOf(w.poPath, "Hello there friend"), "ПЕРЕВОД: Hello there friend");
    assert.equal(msgstrOf(w.poPath, "See you tomorrow"), "ПЕРЕВОД: See you tomorrow");
    assert.equal(msgstrOf(w.poPath, "RestrictSaves"), "RestrictSaves");
    assert.equal(
      msgstrOf(w.poPath, "Good morning to you"),
      "Доброе утро",
      "готовое не перезаписано",
    );
    assert.equal(existsSync(`${w.poPath}.part`), false);
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: PAUSE останавливает после пачки, повторный прогон продолжает с места", async () => {
  const w = work([
    entry("First line here", "speaker:Zoey"),
    entry("Second line here", "speaker:Zoey"),
    entry("Third line here", "speaker:Zoey"),
    entry("Fourth line here", "speaker:Zoey"),
    entry("Fifth line here", "speaker:Zoey"),
    entry("Sixth line here", "speaker:Zoey"),
  ]);
  const pauseFile = join(w.tmpDir, "PAUSE");
  const llm = await fakeLlm((lines, callIndex) => {
    // после второй пачки просим паузу — как человек, дернувший флаг
    if (callIndex === 1) {
      mkdirSync(w.tmpDir, { recursive: true });
      writeFileSync(pauseFile, "pause\n", "utf8");
    }
    return echo(lines);
  });
  try {
    const first = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 2,
      log: () => {},
    });
    assert.equal(first.paused, true, "остановились по PAUSE");
    assert.equal(first.done, 4, "две пачки успели записаться");
    assert.equal(llm.requests.length, 2, "третью пачку модель не звали");

    const kept = msgstrOf(w.poPath, "First line here");
    assert.equal(kept, "ПЕРЕВОД: First line here");
    assert.equal(msgstrOf(w.poPath, "Fifth line here"), "", "пятая строка ещё пуста");

    // продолжаем с места: флаг снят, заполненное не переспрашиваем
    rmSync(pauseFile, { force: true });
    const second = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 2,
      log: () => {},
    });
    assert.equal(second.paused, false);
    assert.equal(second.done, 2, "добрали ровно две пустые");
    assert.equal(second.empty, 2, "в очередь попали только пустые");
    assert.equal(llm.requests.length, 3, "одна пачка на остаток");
    assert.equal(msgstrOf(w.poPath, "First line here"), kept, "уже записанное не перезаписано");
    for (const t of [
      "First line here",
      "Second line here",
      "Third line here",
      "Fourth line here",
      "Fifth line here",
      "Sixth line here",
    ]) {
      assert.equal(msgstrOf(w.poPath, t), `ПЕРЕВОД: ${t}`, `${t} переведена ровно один раз`);
    }
    assert.equal(existsSync(`${w.poPath}.part`), false);
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: сломанные теги — не пишем, строка уходит в review-лог", async () => {
  const w = work([entry("<b>Hot</b> line", "speaker:Zoey")]);
  const llm = await fakeLlm(() => "1. Плохо"); // теги потеряны
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      log: () => {},
    });
    assert.equal(s.done, 0);
    assert.equal(s.failed, 1);
    assert.equal(msgstrOf(w.poPath, "<b>Hot</b> line"), "");
    const review = readFileSync(join(w.tmpDir, "ru.review"), "utf8");
    assert.ok(review.includes("TAG IMBALANCE"), "причина зафиксирована");
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: banned cluster исправляется точечным ретраем (без потери строки)", async () => {
  const w = work([entry("Ghh... What am I... Doing... ", "speaker:Zoey")]);
  // Первый ответ — запрещённое «Фх», второй (после подсказки) — нормальный.
  const llm = await fakeLlm(
    (_lines, call) =>
      (call === 0 ? "Фхааа... Что я... делаю?" : undefined) ?? "Фф... Что я... делаю?",
  );
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      log: () => {},
    });
    assert.equal(s.done, 1, "строка переведена со второй попытки");
    assert.equal(s.failed, 0);
    assert.equal(llm.requests.length, 2, "основной запрос + один исправляющий");
    assert.match(llm.requests[1], /ВАЖНО: Не используй сочетания/, "подсказка ушла в промпт");
    assert.match(msgstrOf(w.poPath, "Ghh... What am I... Doing... ") ?? "", /^Фф/);
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue --repair: переводит заново строку, потерявшую ведущий маркер", async () => {
  const w = work([entry("! Rosie said it", "ui", "Ах, Рози сказала это")]);
  const llm = await fakeLlm(() => "! Рози сказала это");
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      repair: true,
      log: () => {},
    });
    assert.equal(s.queued, 1, "defective translation попал в очередь починки");
    assert.equal(s.done, 1);
    assert.equal(
      msgstrOf(w.poPath, "! Rosie said it"),
      "! Рози сказала это",
      "маркер вернулся, перевод перезаписан",
    );
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: без --repair переведённая строка не перезаписывается", async () => {
  const w = work([entry("! Rosie said it", "ui", "Ах, Рози сказала это")]);
  const llm = await fakeLlm(() => "! Рози сказала это");
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      log: () => {},
    });
    assert.equal(s.queued, 0, "обычная очередь пуста: строка переведена");
    assert.equal(
      msgstrOf(w.poPath, "! Rosie said it"),
      "Ах, Рози сказала это",
      "старый перевод не тронут",
    );
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: непарсибельный ответ — два ретрая и UNPARSABLE в лог", async () => {
  const w = work([entry("Hello there friend", "speaker:Zoey")]);
  // Две строки при n=1 — уже не «голая строка», а преамбула/пояснение:
  // именно такой ответ парсер обязан отвергнуть (см. parseResponse).
  const llm = await fakeLlm(() => "мусор без нумерации\nи ещё строка");
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      retryDelayMs: 0,
      log: () => {},
    });
    assert.equal(s.failed, 1);
    assert.equal(s.done, 0);
    assert.equal(llm.requests.length, 3, "три попытки (retry 1/3, 2/3, стоп)");
    assert.ok(readFileSync(join(w.tmpDir, "ru.review"), "utf8").includes("UNPARSABLE"));
    assert.equal(msgstrOf(w.poPath, "Hello there friend"), "");
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: сервер лежит — выходим без падения, прогресс цел", async () => {
  const w = work([entry("Hello there friend", "speaker:Zoey")]);
  const llm = await fakeLlm(() => ({ status: 500 }));
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      log: () => {},
    });
    assert.equal(s.aborted, true);
    assert.equal(s.done, 0);
    assert.equal(msgstrOf(w.poPath, "Hello there friend"), "", "ничего не записали");
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: эхо (speaker: X) не попадает в po, но фиксируется в логе", async () => {
  const w = work([entry("Hello there friend", "speaker:Zoey")]);
  const llm = await fakeLlm(() => "1. Привет, друг (speaker: Zoey)");
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      log: () => {},
    });
    assert.equal(s.done, 1);
    assert.equal(msgstrOf(w.poPath, "Hello there friend"), "Привет, друг");
    assert.ok(readFileSync(join(w.tmpDir, "ru.review"), "utf8").includes("LEAK"));
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: --dry-run не зовёт модель и ничего не пишет", async () => {
  const w = work([entry("Hello there friend", "speaker:Zoey")]);
  const llm = await fakeLlm((lines) => echo(lines));
  try {
    const s = await runQueue({
      lang: "ru",
      root: w.root,
      poPath: w.poPath,
      tmpDir: w.tmpDir,
      url: llm.url,
      batch: 1,
      dryRun: true,
      log: () => {},
    });
    assert.equal(s.done, 0);
    assert.equal(llm.requests.length, 0);
    assert.equal(msgstrOf(w.poPath, "Hello there friend"), "");
  } finally {
    await llm.close();
    cleanup(w);
  }
});

test("runQueue: `#, skip` не отправляется в модель (счётчик в отчёте)", async () => {
  const root = mkdtempSync(join(REPO, "tmp", "tl-skip-"));
  const tmpDir = join(root, "tmp", "translate-local");
  mkdirSync(join(root, "po"), { recursive: true });
  const poPath = join(root, "po", "ru.po");
  writeFileSync(
    poPath,
    [
      'msgid ""',
      'msgstr ""',
      "",
      "#, skip",
      'msgctxt "ui"',
      'msgid "wK Ax"',
      'msgstr ""',
      "",
      'msgctxt "ui"',
      'msgid "Start the game"',
      'msgstr ""',
      "",
    ].join("\n"),
    "utf8",
  );
  const llm = await fakeLlm((lines) => echo(lines));
  try {
    const s = await runQueue({
      lang: "ru",
      root,
      poPath,
      tmpDir,
      url: llm.url,
      batch: 5,
      log: () => {},
    });
    assert.equal(s.skipped, 1, "skip учтён отдельным счётчиком");
    assert.equal(s.empty, 1, "в очередь попала только переводимая строка");
    assert.equal(s.done, 1);
    assert.equal(llm.requests.length, 1, "один запрос — только живая строка");
    assert.ok(!llm.requests[0].includes("wK Ax"), "skip-текст в промпт не попал");
    assert.ok(llm.requests[0].includes("Start the game"));
    assert.equal(msgstrOf(poPath, "Start the game"), "ПЕРЕВОД: Start the game");
    assert.equal(msgstrOf(poPath, "wK Ax"), "", "skip-строка не тронута");
  } finally {
    await llm.close();
    rmSync(root, { recursive: true, force: true });
  }
});
