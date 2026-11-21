---
name: dump-assets
description: Дамп всех Unity .assets файлов игры в структурированный JSON с реальными объектами (UnityPy)
---

# dump-assets — Дамп Unity asset-ов в JSON

## Описание

Использует [UnityPy](https://pypi.org/project/UnityPy/) для чтения настоящих Unity-объектов
(Object Table + Type Tree + typed fields). Каждый `.assets` превращается в строки JSONL:

- `summaries.jsonl` — по строке на ассет (статистика + settings/UI-строки)
- `tmp/dump/<name>.jsonl` — по строке на объект (глядется через `jq`, стримится)

Никаких чанков (были костылём от нестримимого JSON). Формат: `references/DUMP_FORMAT.md`.

## Использование

```bash
pip install UnityPy
python .opencode/skills/dump-assets/scripts/dump_assets.py
```

## Работа с дампом (смотрим что внутри)

Файлы: `tmp/dump/*.jsonl` + `tmp/dump/summaries.jsonl` (вне гита, регенерируются).
Схема: `references/DUMP_FORMAT.md`. Смотреть — построчно, без загрузки целиком:

```bash
# сколько объектов/диалогов
wc -l tmp/dump/resources.jsonl
# поиск по тексту (rg вместо SQL)
rg -l "beef" tmp/dump/*.jsonl
# первые диалоги ассета
head -n 3 tmp/dump/level0.jsonl
# все summary одним взглядом
cat tmp/dump/summaries.jsonl
# то же через Python (стриминг)
python -c "
import json
n = sum(1 for ln in open('tmp/dump/resources.jsonl', encoding='utf-8') if ln.strip())
print('rows:', n)
"
```

Главное: `path_id` неуникален между типами (PreloadData#1 vs GameObject#1),
поэтому связка — всегда `(asset, path_id, type)`, не голый path_id.

## Формат JSONL (детали: `references/DUMP_FORMAT.md`)

### Summary (строка `summaries.jsonl`)

```json
{
  "asset": "resources",
  "schema_version": "3",
  "total_objects": 100776,
  "object_types": { "MonoBehaviour": 28475, "GameObject": 21251 }
}
```

### Object (строка `<asset>.jsonl`)

```json
{"asset": "resources", "path_id": 1, "type": "Material",
 "strings": {"m_Name": "Orbitron-Bold Atlas Material"},
 "fields": {"m_CustomRenderQueue": -1, "m_DoubleSidedGI": false}}
{"asset": "resources", "path_id": 73203, "type": "MonoBehaviour",
 "strings": {"m_Enabled": 1}}
```

## Поля объекта

| Поле                | Описание                                                   |
| ------------------- | ---------------------------------------------------------- |
| `path_id`           | уникальный ID объекта в файле                              |
| `type`              | Unity class name (GameObject, MonoBehaviour, Texture2D, …) |
| `strings`           | строковые поля объекта (m_Name, …)                         |
| `fields`            | нестроковые поля (int, float, bool, PPtr, Vector3, …)      |
| `dialogues`         | найденные диалоги Speaker/Text (из raw-скана)              |
| `raw_strings`       | прочие строки из raw-байт объекта (top 20)                 |
| `color_parser_list` | мапа именованных цветов `{name: #HEX}` (ColorParserList)   |
| `error`             | если объект не читается                                    |

## Примечания

- Texture2D, AudioClip, Shader и другие бинарные типы — только meta, без пикселей/сэмплов
- PPtr-ссылки сохраняются как `{file_id, path_id}`
- **Dialogues** извлекаются из raw bytes MonoBehaviour (JSON-паттерн `"Speaker":"…","Text":"…"`)
- Объекты без текстовых полей всё равно присутствуют в дампе (для навигации по структуре)

## Тесты

```bash
python .opencode/skills/dump-assets/tests/dump_assets.test.py
```

23 теста: raw-скан, JSON-парсинг, диалоги, PPtr, discover, интеграция с UnityPy, формат индекса.
