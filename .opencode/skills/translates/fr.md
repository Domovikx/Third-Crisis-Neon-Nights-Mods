# fr — règles de traduction (EN→FR, adult visual novel)

Общее ядро — `core.md`. Только французская специфика; блок `PROMPT-START…END`
уходит в системный промпт.

<!-- PROMPT-START -->

French specifics:

- Punctuation: `…` for ellipsis, `—` for dialogue dashes, « guillemets » with non-breaking spaces. French spacing: a space before `! ? : ;` (use a normal space; the engine does not need NBSP).
- Address: `tu` with lovers, friends and peers; `vous` with strangers, officials and hierarchy. A sudden switch to `vous` mid-scene is an error.
- Gender: adjectives/participles agree with the person described. `tu es venue` follows the ADDRESSEE; if unknown, rephrase.
- Names stay as in the source (Zoey, Sarah, Klaudia, Lio, Rosie, Leona, Nova, Max, Felicia, Jaime, Cypher, Trov, Varen, Calliach). `Max` is a woman.
- Adult register: as explicit as the source — `bite` (cock), `chatte` (pussy), `cul` (ass), `seins`/`nichons` (tits), `jouir` (cum), `baiser` (fuck), `clitoris`, `téton`. Never soften to `membre`/`parties intimes`.
- Interjections: `Ah !`, `Oh !`, `Putain`, `Merde`, `Aïe`; adapt moans to French phonetics, never keep English letters.
- Tags <color=...>/<b>: byte-identical, parameters never translated.
- One source line = one output line.

<!-- PROMPT-END -->

## 1. Лексика 18+

| EN          | FR (нейтр.)   | FR (грубо) | Не использовать     |
| ----------- | ------------- | ---------- | ------------------- |
| cock        | bite          | queue      | membre              |
| pussy       | chatte        | minou      | vagin (clínique)    |
| ass         | cul           | fesses     | anus (clínique)     |
| tits        | seins         | nichons    | mamelles            |
| cum         | jouir, sperme | foutre     | éjaculer (clínique) |
| fuck (verb) | baiser        | niquer     | avoir des rapports  |
| clit        | clitoris      | —          | —                   |
| nipple      | téton         | —          | —                   |

## 2. Обращение и род

`tu` — близкие; `vous` — официоз. Причастия с `tu` согласуются с адресатом (`tu es venue`).
Если пол неизвестен — перестроить фразу без причастия.

## 3. Типографика

Пробел перед `! ? : ;` — обязателен по-французски. Одна строка = одна реплика.
Бренды латиницей (`Smutgram`, `CUM`).
