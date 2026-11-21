---
name: translate-local
description: Пакетный перевод пустых msgstr в po/<lang>.po через локальную LLM (OpenAI-compatible /v1/chat/completions). Пауза/резюм, построчная запись, валидация тегов. Python-легаси до порта (tasks/2026-11-21-port-qa-and-translate.md).
license: MIT
compatibility: opencode
---

# translate-local — локальный пакетный перевод PO

Гонит пустые `msgstr` из `po/<lang>.po` через локальную LLM
(OpenAI-совместимый API; по умолчанию `http://127.0.0.1:1234` — LM Studio).
Промпт собирается из скилла `translates`: `core.md` + PROMPT-блок
`translates/<lang>.md` + глоссарий имён из уже переведённых строк.

**Статус:** инструмент работает, но это Python-легаси. Порт на `.mts` —
`tasks/2026-11-21-port-qa-and-translate.md`; до порта путь запуска —
`python .../translate_local.py` (не `.mts`).

## Команды (из корня репозитория)

```bash
# Что уйдёт в модель (без вызовов LLM)
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --limit 5 --dry-run

# Реальный тест: 5 фраз
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --limit 5

# Продолжить с места (заполненные пропускаются сами)
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --batch 8

# Любой язык из config/language-priority.json, кроме en
python .opencode/skills/translate-local/scripts/translate_local.py --lang de --batch 8

# Пауза: файл-пауза (цикл допишет текущую фразу и выйдет)
echo pause > tmp/translate-local/PAUSE
rm tmp/translate-local/PAUSE
```

Модель задаётся `--model` (по умолчанию `trans14` — идентификатор,
под которым модель загружена в LM Studio). `--url` переключает бэкенд,
если он OpenAI-совместим. Список названий языков покрывает все 11 из
`config/language-priority.json`.

## Как устроено

- Очередь: записи с пустым `msgstr` (порядок файла). `--offset N` пропускает
  первые N пустых, `--limit N` — потолок за запуск, `--batch N` — размер пачки.
- Триаж без модели: код/гибрид/версии/GUID/чистые символы → `msgstr = msgid`
  (рантайм такие отбрасывает сам: `best == text`).
- Запись построчно inplace в po (остальное побайтово то же), после каждой пачки
  → Ctrl+C и пауза безопасны, рестарт продолжает.
- Валидация ответа: число строк, баланс `< >`, запрещённые RU-кластеры
  (`фх`, `нгх`, `мгх`). **Длину не проверяем** — по правилу репозитория длина
  не критерий качества (AGENTS.md).
- Не прошло — пусто + строка в `tmp/translate-local/<lang>.review`.
- Пауза: файл `tmp/translate-local/PAUSE`, проверка каждую итерацию.
- Тесты: `python .opencode/skills/translate-local/tests/translate_local.test.py`.

## Языки

Файл языка — `.opencode/skills/translates/<code>.md`; сейчас есть
`ru` (полный) и `de`/`pl` (DRAFT). Нет файла → generic-режим (модель сама
выводит грамматику, SFX не локализованы). Новый язык = новый файл, ядро
не трогаем; см. скилл `translates`.

## После прогона

```bash
node .opencode/skills/extract-text/scripts/po2dat.mts ru   # или npm run po2dat -- ru
node .opencode/skills/translate-qa/scripts/qa_translate.py --out tmp/qa.html
# затем деплой (скилл deploy-translator) и проверка в игре
```

QA и очередь ручного ревью пока на Python; `review_queue.py` без
`output/stable_index.json` не работает (см. `commands/pot.md`).

## RUNBOOK (исторические замеры 28.09 — железо могло измениться)

Оркестрация: LM Studio (`:1234`) — исполнитель; `translate_local.py` —
оркестратор; `po/*.po` — состояние; `po2dat` + deploy — ввод в игру.
Старые замеры: RX 6600 XT 8 ГБ, ~2 сек/строка батчами по 5–8.
Актуальную нагрузку и VRAM проверять перед длинным прогоном; правило
«не играть одновременно с прогоном» остаётся.

Старт по порядку (каждый шаг проверять, дальше не идти):

```bash
lms server start                                   # если :1234 молчит
lms load qwen/qwen3-14b -c 2048 --identifier trans14 -y
# warmup обязателен: первый вызов может упереться в таймаут — это норма
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --batch 8 --limit 200
```

Остановка/пауза/продолжение:

- Пауза: `echo pause > tmp/translate-local/PAUSE` — допишет пачку и встанет.
- Стоп: Ctrl+C в любой момент — запись идёт после каждой пачки, потерь нет.
- Обрыв/падение сервера: скрипт выходит сам, прогресс в po сохранён;
  поднять сервер + модель, warmup, та же команда — продолжит с места.

Мониторинг: `tmp/translate-local/*.log`, `tmp/translate-local/<lang>.review`,
`git diff --stat po/`. Лог игры — другой контур, сюда не смотреть.
