---
name: translate-local
description: Batch translation of po/<lang>.po empty entries via a local LLM (LM Studio + Qwen3-14B). Prompt condensed from translates/ skills. Pause/resume, per-entry writes, tag validation.
license: MIT
compatibility: opencode
---

# translate-local — локальный пакетный перевод PO

Гонит пустые `msgstr` из `po/<lang>.po` через локальную LLM (LM Studio,
OpenAI-совместимый API). Промпт — сжатая версия скилла `translates`:
глоссарий имён, SFX-таблица (RU), copy-through триаж, строгий формат ответа.

## Команды (из корня `NeonTranslator/`)

```bash
# Что за запросы уйдут (без вызовов модели)
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --limit 5 --dry-run

# Реальный тест: 5 фраз
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --limit 5

# Продолжить с места (заполненные пропускаются сами)
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --batch 8

# Пауза: создать файл-паузу (цикл допишет текущую фразу и выйдет)
echo pause > tmp/translate-local/PAUSE
rm tmp/translate-local/PAUSE   # снять паузу
```

## Как устроено

- Очередь: записи с пустым `msgstr` (порядок файла). `--offset N` пропускает
  первые N пустых (чанки по сессиям), `--limit N` —потолок за запуск.
- Триаж без модели: код/гибериш/версии/уже-переведённое → `msgstr = msgid`
  (рантайм такие отбрасывает сам: `best == text`).
- Запись построчно inplace в исходный `po` (остальное побайтово то же);
  каждый ответ пишется сразу → Ctrl+C и пауза безопасны, рестарт продолжает.
- Валидация ответа: число строк, баланс `< >`, запрещённые RU-кластеры
  (`фх`, `нгх`, `мгх`), отношение длин. Не прошло → пусто + строка в
  `tmp/translate-local/<lang>.review`.
- Пауза: файл `tmp/translate-local/PAUSE` — проверка каждую итерацию.
- Тесты: `python .opencode/skills/translate-local/tests/translate_local.test.py`

## Про скилл и языки (SOLID/DRY/KISS)

- Нюансы между языками реальны: род/падежи/обращение (RU род глаголов и
  ты/Вы; DE du/Sie и падежи; PL 7 падежей и pan/pani), SFX под фонетику,
  типографика (RU «», DE „ ", PL „ "), глоссарий имён, длина UI-строк
  (немецкий длиннее!). Триаж и валидация тегов/длин — общие.
- Организация: скилл `translates`, внутри по файлу на язык (`de.md`,
  `pl.md`, ...; `ru.md` — pointer без дублирования). Только отличия
  (SFX, род/обращение, типографика, глоссарий-дельта), PROMPT-блок едет
  в запрос — контекст худой. Новый язык = новый файл, ядро не трогаем
  (OCP). RU идёт встроенной секцией + живыми таблицами скилла; без
  файла — generic-режим с предупреждением.
- Канонический список: что лежит в `po/` (сейчас RU; DE/PL дальше).
  Список в свитчере — UI-суперсет на вырост, не путать.

## После прогона

```bash
python .opencode/skills/extract-text/scripts/po2dat.py ru
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Lang ru
# проверка в игре + qa_translate.py + ревью людей (gated-очередь)
```

## RUNBOOK (проверено вживую 28.09)

Оркестрация: LM Studio server (`:1234`, Vulkan, `trans14` = Qwen3-14B-Q4)
— исполнитель; `translate_local.py` — оркестратор (очередь из po, батчи,
запись); `po/*.po` — состояние; `po2dat` + `deploy.ps1` — ввод в игру.
Ollama не использовать (CPU-фолбэк на RDNA2, процесс убит чтобы не ел ресурсы).

Ресурсы: RX 6600 XT 8GB (модель ~8.4GB partial offload), RAM 31GB,
Ryzen 7800X3D. Правило: НЕ играть одновременно с прогоном (бой за VRAM).
Замерено: ~2 сек/строка батчами по 5–8; 22k остатка = ночь чанками.

Старт по порядку (каждый шаг проверять, дальше не идти):

```bash
lms server start                                   # если :1234 молчит
lms load qwen/qwen3-14b -c 2048 --identifier trans14 -y
curl ... /v1/chat/completions ... "WARM"           # warmup обязателен:
                                                   # первый вызов после
                                                   # загрузки может упереться
                                                   # в таймаут — это норма
python .opencode/skills/translate-local/scripts/translate_local.py --lang ru --batch 8 --limit 200
```

Остановка/пауза/продолжение (все проверены):

- Пауза: `echo pause > tmp/translate-local/PAUSE` — допишет фразу и встанет
  (`paused, progress kept`). Снять: `rm tmp/translate-local/PAUSE`.
- Стоп: Ctrl+C в любой момент — запись идёт после каждой фразы, потерь нет.
- Обрыв соединения / падение сервера: скрипт выходит сам
  (`LLM call failed... stopping, progress kept`). Поднять сервер + модель,
  warmup, rerun той же командой — заполненные скипаются, продолжает с места.
- Перезапуск компа: то же самое — состояние только в `po/*.po` + git.

Мониторинг: `tmp/translate-local/*.log`, `tmp/translate-local/<lang>.review`,
`git diff --stat po/`. В лог игры не смотреть — это другой контур.
