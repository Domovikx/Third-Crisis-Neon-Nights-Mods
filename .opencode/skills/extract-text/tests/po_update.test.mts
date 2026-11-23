/**
 * Тесты `po_update.mts` (порт `po_update.test.py` + границы).
 *
 * Покрыто: перенос/новые записи, legacy вместо `#~`, ретаргет при смене
 * контекста, пустые переводы, комментарии переводчика, дубликаты msgid,
 * кавычки/переводы строк, PO без заголовка, атомарная запись (в т.ч. обрыв).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { newEntry, parsePo, renderPo, type PoEntry } from "../scripts/po_file.mts";
import {
  extractHeader,
  main,
  mergePot,
  renderMerged,
  runPoUpdate,
  type MergedEntry,
} from "../scripts/po_update.mts";
import { writeAtomic } from "../scripts/potgen.mts";

const REPO = resolve(import.meta.dirname, "../../../..");
let root: string;

before(() => {
  mkdirSync(join(REPO, "tmp"), { recursive: true });
  root = mkdtempSync(join(REPO, "tmp", "po-update-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Запись PO для тестов. */
function e(msgid: string, ctxt = "", msgstr = "", refs: string[] = []): PoEntry {
  const entry = newEntry();
  entry.msgid = msgid;
  entry.msgctxt = ctxt;
  entry.msgstr = msgstr;
  entry.refs = refs;
  return entry;
}

test("mergePot: перенос существующего + новая пустая запись, refs обновлены из POT", () => {
  const pot = [e("A", "ui"), e("B", "ui")];
  const po = [e("A", "ui", "А", ["f1"])];
  const { merged, stats } = mergePot(po, pot);

  assert.equal(stats.carried, 1);
  assert.equal(stats.new, 1);
  assert.equal(stats.obsolete, 0);
  const byId = new Map(merged.map((x) => [x.msgid, x]));
  assert.equal(byId.get("A")?.msgstr, "А");
  assert.deepEqual(byId.get("A")?.refs, [], "refs берутся из POT, а не из старого PO");
  assert.equal(byId.get("B")?.msgstr, "");
});

test("mergePot: исчезнувший текст остаётся живым с флагом legacy (никогда #~)", () => {
  const pot = [e("A", "ui")];
  const gone = e("Gone", "ui", "Ушло");
  const { merged, stats } = mergePot([e("A", "ui", "А"), gone], pot);

  assert.equal(stats.legacyKept, 1);
  assert.equal(stats.obsolete, 0);
  const kept = merged.find((x) => x.msgid === "Gone") as MergedEntry;
  assert.equal(kept.msgstr, "Ушло");
  assert.equal(kept.obsolete, undefined);
  assert.deepEqual(kept.flags, ["legacy"]);
  assert.match(kept.translator.at(-1) ?? "", /^legacy: text vanished from POT/);
});

test("mergePot: ретаргет — перевод спасается при смене msgctxt", () => {
  const pot = [e("Go", "speaker:Zed")];
  const old = e("Go", "ui", "Иди", ["translations/old.yaml"]);
  old.translator = ["rich: <b>Иди</b>"];
  const { merged, stats } = mergePot([old], pot);

  assert.equal(stats.retargeted, 1);
  assert.equal(stats.obsolete, 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].msgctxt, "speaker:Zed");
  assert.equal(merged[0].msgstr, "Иди");
  assert.deepEqual(merged[0].translator, ["rich: <b>Иди</b>"]);
  assert.deepEqual(merged[0].refs, [], "refs спасённой записи — из POT");
});

test("mergePot: ретаргет не срабатывает, если одноимённый ключ уже переведён", () => {
  const pot = [e("Go", "speaker:Zed"), e("Go", "speaker:Amy")];
  const po = [e("Go", "speaker:Amy", "Иди"), e("Go", "ui", "Ступай")];
  const { merged, stats } = mergePot(po, pot);

  assert.equal(stats.retargeted, 0);
  const zed = merged.find((x) => x.msgctxt === "speaker:Zed");
  assert.equal(zed?.msgstr, "", "второй одноимённый ключ остаётся пустым");
  assert.equal(merged.find((x) => x.msgctxt === "speaker:Amy")?.msgstr, "Иди");
  // Странность оригинала 1:1: текст «Go» есть в POT (под другими ctxt), поэтому
  // ui-перевод не спасается и НЕ остаётся legacy — он выпадает (merge_pot:
  // `if old["msgid"] in pot_by_text: continue`).
  assert.equal(
    merged.find((x) => x.msgctxt === "ui"),
    undefined,
  );
});

test("mergePot: пустые переводы молча выпадают, obsolete всегда 0", () => {
  const pot = [e("A", "ui")];
  const po = [e("A", "ui", ""), e("Gone", "ui", "")];
  const { merged, stats } = mergePot(po, pot);
  assert.equal(stats.obsolete, 0);
  assert.equal(merged.length, 1);
});

test("mergePot: запись с флагом legacy остаётся в хвосте без изменений", () => {
  const pot = [e("A", "ui")];
  const legacy = e("Triaged", "ui", "Мусор");
  legacy.flags = ["legacy"];
  const { merged, stats } = mergePot([e("A", "ui", "А"), legacy], pot);
  assert.equal(stats.legacyKept, 0, "legacy-записи не считаются заново спасёнными");
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1].flags, ["legacy"]);
});

test("mergePot: auto-normalized не переезжает в новый POT", () => {
  const pot = [e("A", "ui")];
  const po = [e("A", "ui", "А")];
  po[0].flags = ["fuzzy", "auto-normalized"];
  const { merged } = mergePot(po, pot);
  assert.deepEqual(merged[0].flags, ["fuzzy"]);
});

test("mergePot: дубликаты msgid в PO — побеждает последний (как dict в Python)", () => {
  const pot = [e("A", "ui")];
  const { merged } = mergePot([e("A", "ui", "первый"), e("A", "ui", "второй")], pot);
  assert.equal(merged[0].msgstr, "второй");
});

test("mergePot: кавычки и \\n в тексте переживают merge + render + parse", () => {
  const pot = [e('He said "hi"\nbye', "ui")];
  const po = [e('He said "hi"\nbye', "ui", 'Он сказал "привет"\nпока')];
  const { merged } = mergePot(po, pot);
  const text = renderMerged(merged, ["# header"]);
  const back = parsePo(text).filter((x) => x.msgid);

  assert.equal(back.length, 1);
  assert.equal(back[0].msgid, 'He said "hi"\nbye');
  assert.equal(back[0].msgstr, 'Он сказал "привет"\nпока');
  assert.ok(text.includes('msgid "He said \\"hi\\"\\nbye"'));
});

test("renderMerged: комментарии переводчика сохраняются, пустой комментарий = '#'", () => {
  const pot = [e("A", "ui")];
  const old = e("A", "ui", "А");
  old.translator = ["rich: <b>А</b>", "note for humans", ""];
  const { merged } = mergePot([old], pot);
  const out = renderMerged(merged, []);
  assert.ok(out.includes("# rich: <b>А</b>"));
  assert.ok(out.includes("# note for humans"));
  assert.ok(out.includes("\n#\n"), "пустой комментарий рендерится как голая решётка");

  const back = parsePo(out).filter((x) => x.msgid);
  assert.deepEqual(back[0].translator, ["rich: <b>А</b>", "note for humans"]);
  assert.equal(back[0].msgstr, "А");
});

test("renderMerged: obsolete-запись рендерится блоками #~", () => {
  const entry = e("Old", "ui", "Старое");
  const text = renderMerged([{ ...entry, obsolete: true }], []);
  assert.ok(text.includes('#~ msgid "Old"'));
  assert.ok(text.includes('#~ msgstr "Старое"'));
});

test("extractHeader: первый блок до пустой строки, CRLF нормализуется", () => {
  const raw = '# RU\r\nmsgid ""\r\nmsgstr "X\\n"\r\n\r\nmsgid "A"\r\nmsgstr "Б"\r\n';
  assert.deepEqual(extractHeader(raw), ["# RU", 'msgid ""', 'msgstr "X\\n"']);
});

test("extractHeader: PO без пустой строки — в шапку уходит весь файл (странность 1:1)", () => {
  const raw = 'msgid "A"\nmsgstr "Б"\n';
  assert.deepEqual(extractHeader(raw), ['msgid "A"', 'msgstr "Б"']);
});

test("runPoUpdate: CLI-цикл с бэкапом и сохранённой шапкой", () => {
  const dir = join(root, "cli", "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.pot"), renderPo([e("A", "ui"), e("B", "ui")], []), "utf8");
  writeFileSync(join(dir, "de.po"), renderPo([e("A", "ui", "Ä", ["old"])], ["# de"]), "utf8");

  const res = runPoUpdate({ lang: "de", poDir: dir });
  assert.equal(res.stats.carried, 1);
  assert.equal(res.stats.new, 1);
  assert.ok(existsSync(join(dir, "de.po.bak")));

  const out = readFileSync(join(dir, "de.po"), "utf8");
  assert.ok(out.startsWith("# de\n\n"), "шапка переносится дословно");
  const back = parsePo(out).filter((x) => x.msgid);
  assert.deepEqual(
    back.map((x) => [x.msgid, x.msgstr]),
    [
      ["A", "Ä"],
      ["B", ""],
    ],
  );
});

test("runPoUpdate: пустой PO — только новые записи, ведущая пустая строка", () => {
  const dir = join(root, "empty", "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.pot"), renderPo([e("A", "ui")], ["# pot"]), "utf8");
  writeFileSync(join(dir, "ru.po"), "", "utf8");

  const res = runPoUpdate({ lang: "ru", poDir: dir });
  assert.equal(res.stats.new, 1);
  const raw = readFileSync(join(dir, "ru.po"), "utf8");
  assert.ok(raw.startsWith("\n"), "заголовка нет — вывод начинается с пустой строки");
  assert.equal(parsePo(raw).filter((x) => x.msgid).length, 1);
});

test("runPoUpdate: повторный прогон не меняет файл (кроме .bak) и не оставляет .part", () => {
  const dir = join(root, "twice", "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.pot"), renderPo([e("A", "ui")], ["# pot"]), "utf8");
  writeFileSync(join(dir, "ru.po"), renderPo([e("A", "ui", "А")], ["# ru"]), "utf8");

  runPoUpdate({ lang: "ru", poDir: dir });
  const first = readFileSync(join(dir, "ru.po"), "utf8");
  runPoUpdate({ lang: "ru", poDir: dir });
  const second = readFileSync(join(dir, "ru.po"), "utf8");

  assert.equal(second, first);
  assert.equal(existsSync(join(dir, "ru.po.part")), false);
});

test("runPoUpdate: отсутствующий PO — ошибка, файл не создаётся", () => {
  const dir = join(root, "missing", "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.pot"), renderPo([e("A", "ui")], []), "utf8");
  assert.throws(() => runPoUpdate({ lang: "ru", poDir: dir }), /missing/);
  assert.equal(existsSync(join(dir, "ru.po")), false);
});

test("writeAtomic: обрыв записи не обнуляет существующий файл", () => {
  const target = join(root, "atomic", "ru.po");
  mkdirSync(join(root, "atomic"), { recursive: true });
  writeFileSync(target, "СТАРОЕ СОДЕРЖИМОЕ\n", "utf8");
  // Эмулируем обрыв: `.part` уже занят каталогом — запись/переименование падает.
  const part = `${target}.part`;
  mkdirSync(part, { recursive: true });
  writeFileSync(join(part, "junk"), "x", "utf8");

  assert.throws(() => writeAtomic(target, "НОВОЕ\n"));
  assert.equal(readFileSync(target, "utf8"), "СТАРОЕ СОДЕРЖИМОЕ\n");
  rmSync(part, { recursive: true, force: true });
});

test("main: отсутствующий PO → код 1, справка → 0, мусор → 2", () => {
  const dir = join(root, "main", "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.pot"), renderPo([e("A", "ui")], []), "utf8");

  const origErr = console.error;
  console.error = () => {};
  try {
    assert.equal(main(["ru", "--po-dir", dir]), 1);
    assert.equal(main(["--help"]), 0);
    assert.equal(main(["--bogus"]), 2);
  } finally {
    console.error = origErr;
  }
});

// ---------------------------------------------------------------------------
// `#, skip`: пустых строк в PO не создаём, живой перевод сохраняем.
// ---------------------------------------------------------------------------

/** Запись POT с `#, skip` (решение skip-политики). */
function skip(id: string): PoEntry {
  const entry = e(id, "ui");
  entry.flags = ["skip"];
  return entry;
}

test("mergePot: skip-запись без перевода не попадает в PO вовсе", () => {
  const { merged, stats } = mergePot([], [skip("junk"), e("Kept line", "ui")]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].msgid, "Kept line");
  assert.equal(stats.skipped, 1);
  assert.equal(stats.new, 1);
  assert.ok(!renderMerged(merged, ['msgid ""', 'msgstr ""']).includes("junk"));
});

test("mergePot: переведённая skip-запись в PO не попадает вовсе", () => {
  const { merged, stats } = mergePot([e("junk", "ui", "мусор")], [skip("junk")]);
  assert.equal(merged.length, 0, "ни строки, ни перевода: это инфошум");
  assert.equal(stats.skipped, 1);
  assert.equal(stats.carried, 0);
});

test("mergePot: снятый skip убирает метку из PO", () => {
  const old = e("line", "ui", "строка");
  old.flags = ["skip"];
  const { merged } = mergePot([old], [e("line", "ui")]);
  assert.deepEqual(merged[0].flags, [], "POT больше не помечает — метке в PO не место");
});

test("mergePot: перевод под skip-текстом не остаётся ни живым, ни legacy", () => {
  const { merged, stats } = mergePot([e("Gone text", "speaker:Zoey", "Ушло")], [skip("Gone text")]);
  assert.equal(merged.length, 0, "skip-текст не тянет за собой перевод");
  assert.equal(stats.skipped, 1, "в POT это одна skip-запись");
  assert.equal(stats.skipDropped, 1, "перевод под ней отброшен осознанно");
  assert.equal(stats.legacyKept, 0);
});

test("runPoUpdate: skip не создаёт строк в PO, переведённая остаётся с меткой", () => {
  const dir = join(root, "skip-run", "po");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "template.pot"),
    renderPo([skip("junk-key"), e("Normal line", "ui"), skip("kept-key")], []),
    "utf8",
  );
  // Заголовок обязателен: в PO без шапки первый блок считается шапкой
  // (задокументированная странность оригинала) — фикстура не про это.
  writeFileSync(
    join(dir, "ru.po"),
    renderPo([e("kept-key", "ui", "уже есть")], ['msgid ""', 'msgstr ""']),
    "utf8",
  );

  const res = runPoUpdate({ lang: "ru", poDir: dir });
  assert.equal(res.stats.skipped, 2, "оба skip-ключа не заведены");

  const out = readFileSync(join(dir, "ru.po"), "utf8");
  assert.ok(!out.includes("junk-key"), "пустого skip-ключа в PO нет");
  assert.ok(!out.includes("kept-key"), "переведённый skip-ключ тоже не попадает");
  assert.ok(!out.includes('msgstr "уже есть"'), "его перевод не тянется в PO");
  assert.ok(out.includes('msgid "Normal line"\nmsgstr ""'), "обычная строка на месте");
  assert.ok(!/#, skip/.test(out), "ни одной skip-метки в PO");
});
