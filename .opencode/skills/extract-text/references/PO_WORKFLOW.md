# PO_WORKFLOW — мультиязычный цикл по Best Practices (GNU gettext)

Наш конвейер повторяет классический gettext-цикл 1-в-1 (см. GNU gettext manual,
`msgmerge -U`: exact match carry-over, fuzzy matching, backups):

| Gettext BP           | У нас                          | Примечание                                    |
| -------------------- | ------------------------------ | --------------------------------------------- |
| `xgettext` → POT     | `npm run potgen` (Rust)        | EN-база, уникальные `(msgid, msgctxt)`        |
| `msginit` новый язык | копия POT → `po/de.po`         | + header (`Language`, `Plural-Forms`)         |
| `msgmerge -U`        | `npm run po:update -- <lang>`  | carried / new / obsolete (`#~`), бэкап `.bak` |
| перевод              | Poedit / Weblate               | fuzzy-флаги ревьюит человек                   |
| `msgfmt -c`          | `npm run po2dat -- <lang>`     | компиляция в `patch_<lang>.dat` (Rust)        |
| `msgfmt` check       | `npm run qa -- --lang <lang>`  | синтаксис PO + 6 правил качества (Rust)       |
| переключение         | `npm run deploy -- --lang <l>` | `active_lang.txt`, fallback `ru`              |

Правила, отличающиеся от голого gettext (осознанно):

- skip-записи исключены из POT (триаж, не работа переводчика)
  — в текущем POT-хабе skip-флаги не пишутся: триаж остался классификатором для статистики,
  решение о переводимости принимает агент/человек
- rich в POT — только цвет, без `<font>`/`<material>`: `potgen --update` несёт
  `rich_text` из дампа в `po/template.pot`, шрифт выбирает рендер по месту и языку
- `auto-normalized` не едет в `.dat` без снятия флага (review gate)
- divergence-check действует только для `ru` (YAML-дерево — RU-мир)
- latin-leftover — только для кириллических языков
- rich-поля (`r`/`rt`) берутся из `#. rich_text:` шаблона (генерация), не из YAML

Доказано сквозным прогоном DE (98 строк): seed → `.dat` → QA (0.9%) →
`deploy --lang de` → игра → `deploy --lang ru` обратно. Ноль новой инфры на язык.

История: до 2026-11-24 POT/PO-стадии были на TS (`potgen.mts`, `po_update.mts`,
`qa_translate.mts`), ещё раньше — на Python; обе реализации удалены, рабочая —
Rust (`tools/rust-l10n`, `tools/rust-qa`), оракул — золотые фикстуры.
