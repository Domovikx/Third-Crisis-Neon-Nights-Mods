---
name: commit-helper
description: Помощник оформления коммитов — анализирует git diff и генерирует Conventional Commits сообщение на английском языке. Использовать когда нужно составить commit message.
---

# commit-helper — Оформление коммитов

Анализирует изменения в репозитории и генерирует commit message в формате Conventional Commits на английском языке (практика репо — см. `git log`).

## Workflow

1. Запросить `git status` и `git diff --cached --stat` — посмотреть что в индексе
2. Запросить `git diff --cached` — полный diff закешированных изменений
3. Если индекс пуст, запросить `git diff HEAD --stat` — непроиндексированные изменения
4. Определить:
   - **type** — тип изменений (см. таблицу)
   - **scope** — модуль проекта: extractor, translator, proxy, fonts, runtime, build, deploy, yaml, docs, deps
   - **description** — заголовок на английском, повелительное наклонение, макс. 72 символа
   - **body** — подробности: ЧТО и ПОЧЕМУ, не КАК (опционально)
   - **footer** — Breaking changes, Closes #issue (опционально)
5. Вывести готовый commit message пользователю для ручного использования
6. **ВАЖНО: весь commit message — только на английском языке. Заголовок и body.

## Типы изменений

| Type     | Когда использовать                                    |
| -------- | ----------------------------------------------------- |
| feat     | Новая функциональность, новый файл, новая возможность |
| fix      | Исправление бага, ошибки, краша                       |
| refactor | Переписывание кода без изменения поведения            |
| docs     | Документация, README, AGENTS.md, комментарии          |
| style    | Форматирование, отступы, запятые (не CSS)             |
| test     | Новые тесты или правка существующих                   |
| chore    | Обслуживание: deps, конфиги, gitignore                |
| perf     | Оптимизация производительности                        |
| ci       | Изменения в CI/CD                                     |
| build    | Система сборки, скрипты, Python/C# компиляция         |

## Правила хорошего коммита

1. **Весь коммит на английском** — заголовок, body, footer. Никакого русского.
2. **Заголовок** — повелительное наклонение, с маленькой буквы, без точки в конце
   - ✅ `feat(extractor): add rich_text parsing from JSON`
   - ❌ `fix(extractor): исправить краш` (русский)
   - ❌ `feat(extractor): Added rich_text parsing.`
3. **Длина заголовка** — до 72 символов (лучше до 50)
4. **Body** — отвечает на вопросы ЧТО и ПОЧЕМУ, не КАК, только на английском
5. **Body** — пустая строка между заголовком и телом
6. **Breaking change** — `!` после type/scope: `feat(api)!: удалить старый endpoint`
7. **Scope** — модуль проекта (см. AGENTS.md):
   - `extractor` — скрипты извлечения текста
   - `translator` — рантайм-переводчик (C#)
   - `proxy` — dwmapi.dll native proxy
   - `fonts` — шрифты, кириллица
   - `runtime` — DLL рантайма
   - `build` — скрипты сборки
   - `deploy` — деплой переводов
   - `po` — файлы переводов (POT/PO/DAT)
   - `i18n` — многоязычность, свитчер языков
   - `docs` — документация
   - `deps` — зависимости

## Примеры

```
feat(extractor): add support for .bundle files

Rewrote the loader on UnityPy v2, added raw_strings parsing
for PlayMaker FSM in .bundle assets.
```

```
fix(translator): fix crash on empty translation

TranslationLoader threw NullReferenceException on empty translation
strings. Added a null check.
```

```
refactor(build): merge build.py and build_proxy.py

Extracted shared compiler lookup into shared.py.
Simplified path handling via pathlib instead of os.path.
```

```
chore(deps): обновить UnityPy до 2.15.0
```

```
docs(readme): update font installation instructions

Added a section about Cyrillic fonts, fixed outdated paths.
```

```
feat(translator)!: switch to the new dictionary schema

BREAKING CHANGE: dictionary keys now use path_id instead of
raw_text. Old YAML files are incompatible.
```
