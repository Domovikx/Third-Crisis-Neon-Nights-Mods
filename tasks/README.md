# Задачи: как брать и сдавать

Очередь работ по миграции и развитию репозитория. Каждый файл — самодостаточное задание:
взять файл и выполнить, не задавая вопросов о рамках.

Перед первой задачей прочитать `tasks/AGENT.md` — правило «сначала проверь, потом делай»
(для этого репо: паритет с Python-версией, а не «как кажется правильнее»).

## Как взять задачу

1. Открой нужный файл, проверь статус `READY`.
2. Перед стартом поменяй статус на `DOING` в самом файле.
3. Прочитай целиком: «Контекст», «Что сделать», «Приёмка», «Вне рамок».
4. По завершении — допиши журнал в файл, поставь `DONE`.

Статусы: `READY` → `DOING` → `DONE`.

## Правила выполнения

- **Коммит — только по явной просьбе человека** (правило репозитория).
- Порт модуля считается сделанным только при **проверке паритета** на реальных данных:
  старый Python и новый TS на одном входе → одинаковый выход (нормализуя `CRLF`→`LF`).
- Новый код — только `.mts`; python не растёт.
- Каждый порт — с тестами `node --test` рядом с модулем.

## Definition of Done

- [ ] Приёмка из файла задачи выполнена, каждый пункт проверяем одним действием
- [ ] Паритет с Python-версией проверен на реальных данных (или явно обосновано, почему нет)
- [ ] `npm run typecheck`, `npm run lint`, `npm test` — зелёные
- [ ] Старые `.py` удалены из нового дерева (или явно оставлены с причиной)
- [ ] Доки (`AGENTS.md`, `docs/migration.md`, `SKILL.md` скилла) обновлены в том же изменении
- [ ] Статус в файле — `DONE`, журнал дописан

## Задачи

- [2026-11-21-migration-init.md](2026-11-21-migration-init.md) — **DONE** — каркас репозитория,
  перенос данных, порт `text_filters`/`po_file`/`po2dat`, паритет `.dat`
- [2026-11-21-port-potgen.md](2026-11-21-port-potgen.md) — **DONE** — POT-хаб: `potgen.mts` +
  `inventory.mts`; паритет на реальном дампе (33 271 запись, diff пуст), E2E `дамп → POT → .dat`
- [2026-11-21-port-po-tools.md](2026-11-21-port-po-tools.md) — **DONE** — `po_update`,
  `prefill_po`, `find_source`
- [2026-11-21-port-qa-and-translate.md](2026-11-21-port-qa-and-translate.md) — **DONE** —
  `qa_translate`, `review_queue`, `translate_local`
- [2026-11-21-port-build-deploy.md](2026-11-21-port-build-deploy.md) — **DONE** —
  `build.py`/`build_proxy.py` + `deploy.ps1` → `.mts`
- [2026-11-21-dump-assets-island.md](2026-11-21-dump-assets-island.md) — **DONE** —
  решение по python-острову (UnityPy) и его CI-гардам
- [2026-11-21-deprecate-old-repo.md](2026-11-21-deprecate-old-repo.md) — **DONE** —
  пометить старый `NeonTranslator` как DEPRECATED и не дать в него вернуться
- [2026-11-21-audit-pipeline-logic.md](2026-11-21-audit-pipeline-logic.md) — **READY** —
  ревизия логики Neon: что нужен для текстового мультиязыка, что упростить, что переписать
  (озвучка вне рамок)
- [2026-11-21-voiceover-spike.md](2026-11-21-voiceover-spike.md) — **READY** — эксперимент:
  пробная озвучка реплик поверх студийной, приглушение оригинала (ducking), регулятор глубины,
  вердикт go/no-go; основной мод остаётся текстовым
- [2026-11-21-pot-coverage-gaps.md](2026-11-21-pot-coverage-gaps.md) — **READY** — вернуть
  в POT потерянный текст: ~900 уникальных строк (read_failed объекты, длинные UI-описания,
  предложения с точкой, global_strings)
- [2026-11-21-pot-noise-cleanup.md](2026-11-21-pot-noise-cleanup.md) — **READY** — убрать
  из POT ~4 590 шумных записей (имена ассетов, бинарные фрагменты)
- [2026-11-21-pot-context-for-translators.md](2026-11-21-pot-context-for-translators.md) —
  **READY** — вернуть переводчику провенанс (сцена/ассет/соседние строки), порт `find_source`
- [2026-11-21-po2dat-gated-order.md](2026-11-21-po2dat-gated-order.md) — **READY** — gated
  `auto-normalized` не должен скрывать ручной перевод того же текста
- [2026-11-21-translates-language-packs.md](2026-11-21-translates-language-packs.md) — **READY** —
  языковые правила `translates/<code>.md` для 7 языков без файла
- [2026-11-21-e2e-on-game-plan.md](2026-11-21-e2e-on-game-plan.md) — **READY** — план E2E на живой
  игре (сценарии, способы фиксации, критерии падения); запуск только после подтверждения владельцем
- [2026-11-21-extract-studio-voices.md](2026-11-21-extract-studio-voices.md) — **READY** — извлечь
  студийные голоса из игры как референсы для Vox (декодер FSB, manifest, отбор ≥10 с на персонажа)
- [2026-11-21-site-and-installer.md](2026-11-21-site-and-installer.md) — **DONE** — GitHub Pages
  собирается из `site/template.html` с реальным покрытием; инсталлятор-заготовка с планом раскладки
- [2026-11-21-prefill-corpus-decision.md](2026-11-21-prefill-corpus-decision.md) — **READY** —
  откуда `prefill` берёт корпус переводов (сами PO / другие языки / легаси / удалить)
- [2026-11-22-dual-dumper-ts-rust.md](2026-11-22-dual-dumper-ts-rust.md) — **READY** — вторая
  реализация дампера (Rust-ядро) для честного сравнения с TS: паритет, тесты у обоих, бенчмарк
  по фазам и памяти, решение по профиту
- [2026-11-22-port-release-packaging.md](2026-11-22-port-release-packaging.md) — **READY** —
  упаковка релиза с PowerShell на TypeScript (последний скрипт вне стека TS+Rust)
- [2026-11-22-rust-qa-spike.md](2026-11-22-rust-qa-spike.md) — **DONE** — QA на Rust:
  паритет находок и замер масштабирования (1×/10×/100×), решение по коэффициенту, а не по секундам
- [2026-11-22-rust-text-core.md](2026-11-22-rust-text-core.md) — **DONE** — общий PO-крейт +
  `potgen` и `po2dat` на Rust (замер: 50 и 7.5 МБ/с), TS-версии остаются оракулами
- [2026-11-22-llm-judge.md](2026-11-22-llm-judge.md) — **READY** — LLM-судья качества: помечает
  смысловые дефекты (не переводит), калибровка precision/recall, интеграция в очередь ревью
- [2026-11-22-language-pilot-protocol.md](2026-11-22-language-pilot-protocol.md) — **READY** —
  протокол пилота языка: состав выборки, метрики, порог приёмки числом; первый прогон на `ru`
- [2026-11-22-data-integrity-lint.md](2026-11-22-data-integrity-lint.md) — **READY** — независимый
  аудит POT/PO/DAT: структура, экранирование, кодировка, теги, якоря; Rust-инструмент + отчёт
- [2026-11-22-rag-context-experiment.md](2026-11-22-rag-context-experiment.md) — **READY** —
  контекст для переводчика (глоссарий + похожие строки, без эмбеддингов) с гейтом ≥10 %
- [2026-11-22-pot-coverage-audit.md](2026-11-22-pot-coverage-audit.md) — **READY** — аудит
  формирования POT: всё ли видимое игроку попадает в шаблон, с доказательствами и причинами
- [2026-11-22-pot-formation-contract.md](2026-11-22-pot-formation-contract.md) — **READY** — контракт
  формирования POT (13 инвариантов) + максимум тестов: юнит, e2e на синтетике и реальном дампе
