---
name: translate-local
description: Пакетный перевод пустых msgstr в po/<lang>.po через локальную LLM (OpenAI-compatible /v1/chat/completions). Пауза/резюм, запись по пачке, валидация тегов. Node/TypeScript (.mts).
license: MIT
compatibility: opencode
---

# translate-local — локальный пакетный перевод PO

Гонит пустые `msgstr` из `po/<lang>.po` через локальную LLM
(OpenAI-совместимый API; по умолчанию `http://127.0.0.1:1234` — LM Studio).
Промпт собирается из скилла `translates`: `core.md` + PROMPT-блок
`translates/<lang>.md` + глоссарий имён из уже переведённых строк.

**Статус:** порт на `.mts` выполнен 2026-11-21 (`scripts/translate_local.py` —
референс до удаления, не править и не звать).

## Команды (из корня репозитория)

```bash
# Что уйдёт в модель (без вызовов LLM)
node .opencode/skills/translate-local/scripts/translate_local.mts --lang ru --limit 5 --dry-run

# Реальный тест: 5 фраз
node .opencode/skills/translate-local/scripts/translate_local.mts --lang ru --limit 5

# Продолжить с места (заполненные пропускаются сами)
node .opencode/skills/translate-local/scripts/translate_local.mts --lang ru --batch 8

# Любой язык из config/language-priority.mts, кроме en
node .opencode/skills/translate-local/scripts/translate_local.mts --lang de --batch 8

# Пауза: файл-пауза (цикл допишет текущую пачку и выйдет)
echo pause > tmp/translate-local/PAUSE
rm tmp/translate-local/PAUSE
```

Модель задаётся `--model` (по умолчанию `trans14` — идентификатор, под которым
модель загружена в LM Studio). `--url` переключает бэкенд, если он
OpenAI-совместим. Список языков и их названия для промпта берутся из
`config/language-priority.mts` (свой хардкод не заводить); неизвестный код —
ошибка со списком допустимых.

## Как устроено

- Очередь: записи с пустым `msgstr` (порядок файла). `--offset N` пропускает
  первые N пустых, `--limit N` — потолок за запуск, `--batch N` — размер пачки.
- Триаж без модели: код/гибрид/версии/GUID/чистые символы → `msgstr = msgid`
  (рантайм такие отбрасывает сам: `best === text`).
- Запись в po после каждой пачки, атомарно (`.part` → rename), остальное
  содержимое файла не меняется → Ctrl+C и пауза безопасны, рестарт продолжает.
- Заполненный `msgstr` не перезаписывается никогда: одинаковый текст в другом
  контексте сохраняет свой перевод.
- Валидация ответа: число строк, баланс `< >`, запрещённые RU-кластеры
  (`фх`, `нгх`, `мгх`). **Длину не проверяем** — по правилу репозитория длина
  не критерий качества (`AGENTS.md`).
- Не прошло — строка остаётся пустой + запись в `tmp/translate-local/<lang>.review`.
- Пауза: файл `tmp/translate-local/PAUSE`, проверка перед каждой пачкой.
- Сеть: встроенный `fetch` + `AbortSignal.timeout` (`--timeout`, секунды).
- Тесты: `node --test .opencode/skills/translate-local/tests/translate_local.test.mts`
  (локальный фейковый OpenAI-сервер на `node:http`, реальная LLM не зовётся).

## Языки

Файл языка — `.opencode/skills/translates/<code>.md`; сейчас есть
`ru` (полный) и `de`/`pl` (DRAFT). Нет файла → generic-режим (модель сама
выводит грамматику, SFX не локализованы). Новый язык = новый файл, ядро
не трогаем; см. скилл `translates`.

## После прогона

```bash
npm run po2dat -- ru
npm run qa -- --lang ru --out tmp/qa.html
# затем деплой (скилл deploy-translator) и проверка в игре
```

## RUNBOOK (исторические замеры 28.09 — железо могло измениться)

Оркестрация: LM Studio (`:1234`) — исполнитель; `translate_local.mts` —
оркестратор; `po/*.po` — состояние; `po2dat` + deploy — ввод в игру.
Старые замеры: RX 6600 XT 8 ГБ, ~2 сек/строка батчами по 5–8.
Актуальную нагрузку и VRAM проверять перед длинным прогоном; правило
«не играть одновременно с прогоном» остаётся.

Старт по порядку (каждый шаг проверять, дальше не идти):

```bash
lms server start                                   # если :1234 молчит
lms load qwen/qwen3-14b -c 2048 --identifier trans14 -y
# warmup обязателен: первый вызов может упереться в таймаут — это норма
node .opencode/skills/translate-local/scripts/translate_local.mts --lang ru --batch 8 --limit 200
```

Остановка/пауза/продолжение:

- Пауза: `echo pause > tmp/translate-local/PAUSE` — допишет пачку и встанет.
- Стоп: Ctrl+C в любой момент — запись идёт после каждой пачки, потерь нет.
- Обрыв/падение сервера: скрипт выходит с кодом 1, прогресс в po сохранён;
  поднять сервер + модель, warmup, та же команда — продолжит с места.

Мониторинг: `tmp/translate-local/*.log`, `tmp/translate-local/<lang>.review`,
`git diff --stat po/`. Лог игры — другой контур, сюда не смотреть.
