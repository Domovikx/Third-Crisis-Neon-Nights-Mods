/**
 * Тесты `prefill_po.mts` (порт `prefill_po.py` + границы).
 *
 * Покрыто: мини-читатель YAML-корпуса, порядок источников, нормализация
 * текста, exact/fuzzy/auto-normalized/conflict/missing/orphans, приоритет
 * человеческих переводов, blocklist, атомарная запись и CLI-границы.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { newEntry, parsePo, renderPo, type PoEntry } from "../scripts/po_file.mts";
import {
  buildRuCorpus,
  buildRuPo,
  cpSlice,
  entryContext,
  iterSourceEntries,
  loadBlocklist,
  main,
  normalizeText,
  pyFixed1,
  pyRepr,
  readYamlEntries,
  ruHeaderLines,
  runPrefill,
  yamlScalar,
  yamlUnescapeDouble,
  type CorpusEntry,
} from "../scripts/prefill_po.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "prefill-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function entry(msgid: string, ctxt = "", msgstr = ""): PoEntry {
  const e = newEntry();
  e.msgid = msgid;
  e.msgctxt = ctxt;
  e.msgstr = msgstr;
  return e;
}

/** POT-текст с шапкой (как настоящий). */
function potText(entries: PoEntry[]): string {
  return renderPo(entries, ["# pot"]);
}

/** Запись корпуса (по умолчанию — диалог со спикером). */
function ce(
  text: string,
  translation: string,
  speaker = "",
  rel = "translations/dialogues/1.yaml",
  skipTranslation = false,
): CorpusEntry {
  return { text, translation, speaker, rel, skipTranslation };
}

function fill(input: {
  pot: PoEntry[];
  corpus?: CorpusEntry[];
  old?: string | null;
  blocked?: string[];
}): ReturnType<typeof buildRuPo> {
  return buildRuPo({
    potText: potText(input.pot),
    oldPoText: input.old ?? null,
    corpus: input.corpus ?? [],
    blocked: new Set(input.blocked ?? []),
  });
}

test("yamlScalar: двойные/одинарные кавычки, эскейпы, булевы, plain", () => {
  assert.equal(yamlScalar('"a\\nb"'), "a\nb");
  assert.equal(yamlScalar('"say \\"hi\\""'), 'say "hi"');
  assert.equal(yamlScalar('"C:\\\\path"'), "C:\\path");
  assert.equal(yamlScalar("'it''s'"), "it's");
  assert.equal(yamlScalar("true"), true);
  assert.equal(yamlScalar("false"), false);
  assert.equal(yamlScalar("~"), null);
  assert.equal(yamlScalar("plain words"), "plain words");
  assert.equal(yamlUnescapeDouble("\\u0416"), "Ж");
  assert.equal(yamlUnescapeDouble("\\x41"), "A");
  assert.equal(yamlUnescapeDouble("\\q"), "q", "неизвестный эскейп = сам символ (yaмl-совместимо)");
});

test("readYamlEntries: список словарей, пустой файл, CRLF, комментарии", () => {
  const dir = join(root, "yaml");
  mkdirSync(dir, { recursive: true });
  const listPath = join(dir, "list.yaml");
  writeFileSync(
    listPath,
    '# Dialogues\r\n\r\n- text: "Hi"\r\n  translation: "Привет"\r\n  skip_translation: true\r\n\r\n' +
      "- text: \"Bye\"\r\n  translation: 'Пока'\r\n",
    "utf8",
  );
  const entries = readYamlEntries(listPath);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { text: "Hi", translation: "Привет", skip_translation: true });
  assert.deepEqual(entries[1], { text: "Bye", translation: "Пока" });

  const emptyPath = join(dir, "empty.yaml");
  writeFileSync(emptyPath, "", "utf8");
  assert.deepEqual(readYamlEntries(emptyPath), []);
  assert.deepEqual(readYamlEntries(join(dir, "nope.yaml")), [], "нет файла — пусто, без падения");
});

test("iterSourceEntries: порядок dialogues → settings → raw → speakers, rel как у Python", () => {
  const corpus = join(root, "corpus-order", "translations");
  for (const sub of ["dialogues", "settings", "raw"])
    mkdirSync(join(corpus, sub), { recursive: true });
  writeFileSync(join(corpus, "dialogues", "b.yaml"), '- text: "B"\n  translation: "Б"\n', "utf8");
  writeFileSync(join(corpus, "dialogues", "a.yaml"), '- text: "A"\n  translation: "А"\n', "utf8");
  writeFileSync(join(corpus, "settings", "s.yaml"), '- text: "S"\n  translation: "С"\n', "utf8");
  writeFileSync(join(corpus, "raw", "r.yaml"), '- text: "R"\n  translation: "Р"\n', "utf8");
  writeFileSync(join(corpus, "speakers.yaml"), '- text: "Zoey"\n  translation: "Зои"\n', "utf8");

  const got = iterSourceEntries(corpus).map((e) => [e.text, e.rel]);
  assert.deepEqual(got, [
    ["A", "translations/dialogues/a.yaml"],
    ["B", "translations/dialogues/b.yaml"],
    ["S", "translations/settings/s.yaml"],
    ["R", "translations/raw/r.yaml"],
    ["Zoey", "translations/speakers.yaml"],
  ]);
  assert.equal(entryContext(iterSourceEntries(corpus).at(-1) as CorpusEntry), "speaker-name");
});

test("entryContext: спикер / имя персонажа / ui", () => {
  assert.equal(entryContext(ce("Hi", "П", "Zoey")), "speaker:Zoey");
  assert.equal(entryContext(ce("Zoey", "Зои", "", "translations/speakers.yaml")), "speaker-name");
  assert.equal(entryContext(ce("Hi", "П", "  ")), "ui");
});

test("normalizeText: маркеры, пунктуация, апострофы и растяжения выкидываются", () => {
  assert.equal(normalizeText("004 Yeees yeees Ill be thereee 1"), "yes yes ill be there");
  assert.equal(normalizeText("Yeees yeees, I'll be thereee!"), "yes yes ill be there");
  assert.equal(normalizeText("Aw, ...!"), normalizeText("000 Aw ... 2"));
  assert.equal(normalizeText(""), "");
});

test("buildRuCorpus: skip-записи вне карты, «skip с переводом» только при tr != text", () => {
  const corpus = [
    ce("Hi", "Привет", "Zoey"),
    ce("Skip", "Скип", "Zoey", undefined, true),
    ce("Copy", "Copy", "Zoey", undefined, true),
    ce("Hi", "Привет!", "Amy"),
  ];
  const { map, skippedWithTranslation } = buildRuCorpus(corpus);
  assert.equal(skippedWithTranslation.length, 1);
  assert.deepEqual(skippedWithTranslation[0], {
    text: "Skip",
    ctxt: "speaker:Zoey",
    translation: "Скип",
    file: "translations/dialogues/1.yaml",
  });
  assert.equal(map.size, 2);
  const hi = [...map.values()].find((s) => s.key[0] === "Hi");
  assert.deepEqual(
    hi?.variants.map((v) => v.translation),
    ["Привет"],
  );
});

test("buildRuPo: exact — перевод точного ключа, без флагов", () => {
  const { entries, report } = fill({
    pot: [entry("Hi", "speaker:Zoey")],
    corpus: [ce("Hi", "Привет", "Zoey")],
  });
  assert.equal(report.total, 1);
  assert.equal(report.exact, 1);
  assert.equal(entries[0].msgstr, "Привет");
  assert.deepEqual(entries[0].flags, []);
});

test("buildRuPo: fuzzy — один вариант на голый текст при дрейфе контекста", () => {
  const { entries, report } = fill({
    pot: [entry("Hi", "ui")],
    corpus: [ce("Hi", "Привет", "Zoey")],
  });
  assert.equal(report.fuzzy.length, 1);
  assert.equal(entries[0].msgstr, "Привет");
  assert.deepEqual(entries[0].flags, ["fuzzy"]);
  assert.deepEqual(report.fuzzy[0], [["Hi", "ui"], "Привет"]);
});

test("buildRuPo: conflict — разные переводы одного ключа, запись остаётся пустой", () => {
  const { entries, report } = fill({
    pot: [entry("Hi", "speaker:Zoey")],
    corpus: [ce("Hi", "Привет", "Zoey"), ce("Hi", "Здорово", "Zoey", "translations/raw/9.yaml")],
  });
  assert.equal(report.conflicts.length, 1);
  assert.equal(entries[0].msgstr, "");
  assert.deepEqual(entries[0].flags, []);
  assert.equal(report.conflicts[0][1].length, 2);
});

test("buildRuPo: auto-normalized — урезанный вариант наследует близнеца", () => {
  const { entries, report } = fill({
    pot: [entry("000 Aw ... 2", "ui")],
    corpus: [ce("Aw, ...!", "Оу...")],
  });
  assert.equal(report.autoNormalized.length, 1);
  assert.equal(entries[0].msgstr, "Оу...");
  assert.deepEqual(entries[0].flags, ["fuzzy", "auto-normalized"]);
});

test("buildRuPo: blocklist отменяет auto-normalized (строка уходит в missing)", () => {
  const { entries, report } = fill({
    pot: [entry("000 Aw ... 2", "ui")],
    corpus: [ce("Aw, ...!", "Оу...")],
    blocked: ["aw"],
  });
  assert.equal(report.autoNormalized.length, 0);
  assert.equal(report.missing.length, 1);
  assert.equal(entries[0].msgstr, "");
});

test("buildRuPo: missing и orphans считаются по POT-ключам", () => {
  const { report } = fill({
    pot: [entry("New", "ui")],
    corpus: [ce("Gone", "Ушло", "Zoey")],
  });
  assert.deepEqual(report.missing, [["New", "ui"]]);
  assert.equal(report.orphans.length, 1);
  assert.deepEqual(report.orphans[0][0], ["Gone", "speaker:Zoey"]);
});

test("buildRuPo: человеческий перевод и комментарии не пересчитываются", () => {
  const old = renderPo(
    [
      {
        ...entry("Hi", "speaker:Zoey", "Здравствуй"),
        translator: ["note for humans"],
        flags: ["fuzzy"],
      },
    ],
    ["# ru"],
  );
  const { entries, report } = fill({
    pot: [entry("Hi", "speaker:Zoey")],
    corpus: [ce("Hi", "Привет", "Zoey")],
    old,
  });
  assert.equal(report.exact, 1);
  assert.equal(entries[0].msgstr, "Здравствуй");
  assert.deepEqual(entries[0].translator, ["note for humans"]);
  assert.deepEqual(entries[0].flags, ["fuzzy"]);
});

test("buildRuPo: auto-normalized в старом PO пересчитывается заново", () => {
  const old = renderPo(
    [
      {
        ...entry("000 Aw ... 2", "ui", "старое"),
        flags: ["fuzzy", "auto-normalized"],
      },
    ],
    ["# ru"],
  );
  const { entries, report } = fill({
    pot: [entry("000 Aw ... 2", "ui")],
    corpus: [ce("Aw, ...!", "Оу...")],
    old,
  });
  assert.equal(report.autoNormalized.length, 1);
  assert.equal(entries[0].msgstr, "Оу...");
  assert.deepEqual(entries[0].flags, ["fuzzy", "auto-normalized"]);
});

test("buildRuPo: пустой POT и PO без заголовка — без падений", () => {
  const empty = fill({ pot: [] });
  assert.equal(empty.report.total, 0);
  assert.deepEqual(empty.entries, []);

  const noHeader = fill({
    pot: [entry("A")],
    old: 'msgid "A"\nmsgstr "Б"\n',
  });
  assert.equal(noHeader.entries[0].msgstr, "Б");
});

test("buildRuPo: кавычки и \\n переживают render + parse", () => {
  const id = 'He said "hi"\nbye';
  const { entries } = fill({
    pot: [entry(id, "ui")],
    corpus: [ce(id, 'Он сказал "привет"\nпока')],
  });
  const back = parsePo(
    renderPo(entries, ruHeaderLines(new Date(Date.UTC(2026, 0, 2, 3, 4)))),
  ).filter((e) => e.msgid);
  assert.equal(back[0].msgid, id);
  assert.equal(back[0].msgstr, 'Он сказал "привет"\nпока');
});

test("loadBlocklist: комментарии после # отрезаются, CRLF не мешает", () => {
  const dir = join(root, "blocklist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "autofill_blocklist.txt"),
    "# header\r\ndildo # foreign-marker\r\n\r\n  impact  \r\n",
    "utf8",
  );
  assert.deepEqual([...loadBlocklist(dir)], ["dildo", "impact"]);
  assert.deepEqual([...loadBlocklist(join(root, "none"))], []);
});

test("runPrefill: пишет ru.po с шапкой, атомарно и идемпотентно", () => {
  const poDir = join(root, "run", "po");
  mkdirSync(poDir, { recursive: true });
  writeFileSync(join(poDir, "template.pot"), potText([entry("Hi", "speaker:Zoey")]), "utf8");
  const corpusDir = join(root, "run", "translations");
  mkdirSync(join(corpusDir, "dialogues"), { recursive: true });
  writeFileSync(
    join(corpusDir, "dialogues", "1.yaml"),
    '- text: "Hi"\n  translation: "Привет"\n  speaker: "Zoey"\n',
    "utf8",
  );

  const now = new Date(Date.UTC(2026, 0, 2, 3, 4));
  const res = runPrefill({ lang: "ru", poDir, corpusDir, now });
  assert.equal(res.report.exact, 1);
  const first = readFileSync(join(poDir, "ru.po"), "utf8");
  assert.ok(first.startsWith("# Russian translation for NeonTranslator"));
  assert.ok(first.includes('"PO-Revision-Date: 2026-01-02 03:04+0000\\n"'));
  assert.ok(first.includes('msgstr "Привет"'));

  runPrefill({ lang: "ru", poDir, corpusDir, now });
  assert.equal(readFileSync(join(poDir, "ru.po"), "utf8"), first, "второй прогон байт-в-байт");
  assert.equal(existsSync(join(poDir, "ru.po.part")), false);
});

test("runPrefill: без template.pot — ошибка «сначала potgen»", () => {
  const poDir = join(root, "no-pot", "po");
  mkdirSync(poDir, { recursive: true });
  assert.throws(() => runPrefill({ poDir }), /potgen/);
  assert.equal(existsSync(join(poDir, "ru.po")), false);
});

test("pyRepr / cpSlice / pyFixed1: отчётные примитивы как в Python", () => {
  assert.equal(pyRepr("plain"), "'plain'");
  assert.equal(pyRepr('say "hi"'), `'say "hi"'`);
  assert.equal(pyRepr('it\'s "x"'), `'it\\'s "x"'`);
  assert.equal(pyRepr("a\nb\tc\\d"), "'a\\nb\\tc\\\\d'");
  assert.equal(pyRepr("Ж"), "'Ж'", "кириллица печатается как есть");
  assert.equal(pyRepr("\u00a0"), "'\\xa0'");
  assert.equal(cpSlice("a😀b", 1), "a");
  assert.equal(cpSlice("a😀b", 2), "a😀", "срез по code points, не UTF-16");
  assert.equal(pyFixed1(55.93), "55.9");
  assert.equal(pyFixed1(0.25), "0.2", "полук — к чётному (Python format)");
  assert.equal(pyFixed1(100), "100.0");
});

test("main: справка → 0, без POT → 1, мусор → 2", () => {
  const poDir = join(root, "main", "po");
  mkdirSync(poDir, { recursive: true });

  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(main(["--help"]), 0);
    assert.equal(main(["--po-dir", poDir]), 1);
    assert.equal(main(["--bogus"]), 2);
  } finally {
    console.error = origErr;
  }
});
