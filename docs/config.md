# Конфиги: `.mts` — источник, JSON — артефакт

Решение владельца (2026-11-26). Конфиги — это код: типизированные объекты
(`as const satisfies`), которые импортируются напрямую и проверяются `tsc`.
JSON рядом остался только там, где его читает Rust или рантайм, и **руками не
правится** — он генерируется модулем. Ошибка в данных ловится типами и тестами.

## Файлы

- **Только TS (JSON удалён):**
  - `config/name-canon.mts` — канон имён персонажей: одна форма на язык
    (`scripts/name_canon.mts`, `scripts/name_canon.test.mts`);
  - `config/speaker-gender.mts` — пол спикера, выведенный из корпуса (формы
    1-го лица). **Артефакт генерации**: `node scripts/speaker_gender.mts --write`
    пересобирает его из `po/ru.po`;
  - `config/voice-characters.mts` — карта персонажей озвучки.
- **`.mts` + JSON-артефакт** (JSON читают Rust и/или скрипты):

  | модуль                         | JSON                     | читатели                       |
  | ------------------------------ | ------------------------ | ------------------------------ |
  | `config/language-priority.mts` | `language-priority.json` | `rust-lint`, сайт, дашборд     |
  | `config/pot-src-policy.mts`    | `pot-src-policy.json`    | `rust-l10n` (potgen), проверки |
  | `config/pot-skip-policy.mts`   | `pot-skip-policy.json`   | `rust-l10n` (potgen), проверки |
  | `config/pot-skip-ids.mts`      | `pot-skip-ids.json`      | `rust-l10n` (potgen), проверки |

- **`config/game-snapshot.json` — не конфиг, а снимок** версии установленной
  игры. Его пишет `npm run check:version -- --write` из Steam-манифеста
  (`scripts/game_version.mts`), поэтому он остаётся JSON-артефактом.

## Как менять

1. Правка — в `.mts` (не в JSON). Для `speaker-gender` — не править вообще:
   пересобрать `node scripts/speaker_gender.mts --write`.
2. Перегенерировать артефакт:

   ```bash
   node config/language-priority.mts > config/language-priority.json
   node config/pot-src-policy.mts    > config/pot-src-policy.json
   node config/pot-skip-policy.mts   > config/pot-skip-policy.json
   node config/pot-skip-ids.mts      > config/pot-skip-ids.json
   ```

   Модуль печатает JSON через `config/emit.mts` (prettier от компактной
   записи), поэтому вывод детерминирован и побайтно равен закоммиченному файлу.

3. `npm test` — паритет-тесты `config/<name>.test.mts` падают, если JSON и
   модуль разошлись; в сообщении — готовая команда перегенерации.

## Почему JSON не удалён полностью

Его читает Rust (`tools/rust-l10n/src/potgen.rs`, `tools/rust-lint/src/main.rs`)
и скрипты, которые не должны зависеть от TS-типов (сайт, дашборд, инсталлятор).
Вариант «Rust парсит TypeScript» дороже и хрупче, поэтому граница проведена по
потребителю: модуль — источник, JSON — мост.

Шапку-комментарий в JSON положить нельзя, поэтому документация живёт в `.mts`
(шапка модуля) и здесь, а сам JSON несёт `_comment`/`_rules` — эти поля данные,
а не код, и парсеры их игнорируют.
