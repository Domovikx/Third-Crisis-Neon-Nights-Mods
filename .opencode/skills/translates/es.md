# es — reglas de traducción (EN→ES, adult visual novel)

Общее ядро — `core.md`. Здесь только испанская специфика. Блок `PROMPT-START…END`
уходит в системный промпт (`loadLangSkill` в `translate-local`), остальное — для ревью.

<!-- PROMPT-START -->

Spanish specifics:

- Punctuation: open marks are obligatory — `¿…?` and `¡…!` (also after a comma: `…, ¿verdad?`). Use `...` for ellipsis, `—` for dialogue dashes. Quotes: «…» (or “…” consistently, never mixed).
- Address: `tú` with lovers, friends and peers; `usted` with strangers, officials and service hierarchy. A sudden switch to `usted` mid-scene is an error.
- Gender: adjectives and participles agree with the person they describe. Second-person past (`tú dijiste`) has no gender, but participles do (`estás cansada`) — use the SPEAKER/ADDRESSEE hint; when unknown, prefer a construction that avoids the participle.
- Names stay as in the source (Zoey, Sarah, Klaudia, Lio, Rosie, Leona, Nova, Max, Felicia, Jaime, Cypher, Trov, Varen, Calliach). Never invent a translated name; `Max` is a woman.
- Adult register: as explicit as the source. Use `polla` (cock), `coño` (pussy), `culo` (ass), `tetas` (tits), `correrse` (cum), `follar` (fuck), `clítoris`, `pezón`. Never soften to `miembro`/`zona`/`partes íntimas` unless the source itself is clinical.
- Interjections: `Ah!`, `Oh!`, `Uf!`, `Ay!`, `Mmm`, `Joder`, `Mierda`; adapt moans to Spanish phonetics, never keep English letters (`Fghh` → `Mmm`, `Agh` → `Ay`).
- Tags <color=...>, <b>, <size=...>: keep byte-identical, translate only the text inside; never translate tag parameters.
- One source line = one output line, no line breaks; never leave an English word that is not a brand.

<!-- PROMPT-END -->

## 1. Puntuación

- `¿` y `¡` — обязательны в начале вопроса/восклицания, в том числе внутри фразы.
- Многоточие `...` (три точки); тире диалога `—` с пробелами.
- Кавычки — «ёлочки» (как в русском) или “английские” парой; не смешивать в одном файле.
- Числа и проценты: `10 %` (с пробелом) или `10%` — как в оригинале.

## 2. Обращение и род

- `tú` — близкие, любовники, ровесники; `usted` — незнакомцы, начальство, официальная служба.
- В интимной сцене переход на `usted` — ошибка (как «Вы» в русском).
- Причастия согласуются с тем, о ком речь: `estás cansada` (женщина), `estás cansado` (мужчина).
- Если пол неизвестен — перестроить фразу без причастия (`te veo agotada` → `pareces agotada` тоже род… лучше `no puedes más`).

## 3. Стоны и междометия

Не транслитерировать английские (`Fghh`, `Nghh`): `Mmm`, `Nngh` → `Mmm`, `Ay`, `Uf`, `Ahh`.
Таблица по языкам — общая задача `2026-11-24-sfx-moans-conventions.md` (ресёрч).

## 4. Лексика 18+

| EN          | ES (нейтр.)     | ES (грубо) | Не использовать     |
| ----------- | --------------- | ---------- | ------------------- |
| cock        | polla           | verga      | miembro             |
| pussy       | coño            | chochete   | vagina (clínico)    |
| ass         | culo            | trasero    | ano (clínico)       |
| tits        | tetas           | pechos     | mamas               |
| cum         | correrse, semen | leche      | eyacular (clínico)  |
| fuck (verb) | follar          | tirarse    | mantener relaciones |
| clit        | clítoris        | —          | —                   |
| nipple      | pezón           | —          | —                   |

## 5. Типографика

- Одна строка — одна реплика, без переносов.
- Не оставлять английские слова, кроме брендов (`Smutgram`, `Pocket Pussy`, `CUM`).
