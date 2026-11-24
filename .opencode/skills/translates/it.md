# it — regole di traduzione (EN→IT, adult visual novel)

Общее ядро — `core.md`. Только итальянская специфика; блок `PROMPT-START…END`
уходит в системный промпт.

<!-- PROMPT-START -->

Italian specifics:

- Punctuation: `…` for ellipsis, `—` for dialogue dashes, « virgolette » (or “…” consistently).
- Address: `tu` with lovers, friends and peers; `lei` (capitalised Lei) with strangers, officials and hierarchy. A sudden switch mid-scene is an error.
- Gender: adjectives and participles agree with the person described; `tu sei venuta` follows the ADDRESSEE. If unknown, rephrase.
- Names stay as in the source (Zoey, Sarah, Klaudia, Lio, Rosie, Leona, Nova, Max, Felicia, Jaime, Cypher, Trov, Varen, Calliach). `Max` is a woman.
- Adult register: as explicit as the source — `cazzo` (cock), `figa` (pussy), `culo` (ass), `tette` (tits), `venire`/`sborrare` (cum), `scopare` (fuck), `clitoride`, `capezzolo`. Never soften to `membro`/`parti intime`.
- Interjections: `Ah!`, `Oh!`, `Cazzo`, `Merda`, `Ahi`; adapt moans to Italian phonetics, never keep English letters.
- Tags <color=...>/<b>: byte-identical, parameters never translated.
- One source line = one output line.

<!-- PROMPT-END -->

## 1. Лексика 18+

| EN          | IT (нейтр.)    | IT (грубо) | Не использовать     |
| ----------- | -------------- | ---------- | ------------------- |
| cock        | cazzo          | uccello    | membro              |
| pussy       | figa           | fica       | vagina (clinico)    |
| ass         | culo           | sedere     | ano (clinico)       |
| tits        | tette          | seno       | mammelle            |
| cum         | venire, sborra | seme       | eiaculare (clinico) |
| fuck (verb) | scopare        | fottere    | avere rapporti      |
| clit        | clitoride      | —          | —                   |
| nipple      | capezzolo      | —          | —                   |

## 2. Обращение и род

`tu` — близкие; `Lei` — официоз. Причастия с `tu` согласуются с адресатом (`tu sei venuta`).

## 3. Типографика

Одна строка = одна реплика; бренды латиницей (`Smutgram`, `CUM`).
