# ko — 한국어 번역 규칙 (EN→KO, adult visual novel)

Общее ядро — `core.md`. Только корейская специфика; блок `PROMPT-START…END`
уходит в системный промпт (как `zh.md`).

<!-- PROMPT-START -->

Korean specifics:

- Punctuation: full-width 。, 、 are NOT used in Korean — use ASCII-period style with Korean spacing: `…` or `...` for ellipsis, `!` `?` half-width, quotes “ ” (nested ‘ ’). Do not insert spaces between Hangul syllables.
- Address: 반말 with lovers/friends/peers, 존댓말 (해요체/합쇼체) with strangers and officials. A sudden switch mid-scene is an error; hierarchy matters more than in English.
- Gender: no grammatical gender; pronouns 그/그녀 are rare — prefer omission. Pick the SPEAKER field only when a pronoun is unavoidable.
- Names in Hangul: 조이 (Zoey), 사라 (Sarah), 클라우디아 (Klaudia), 리오 (Lio), 로지 (Rosie), 레오나 (Leona), 노바 (Nova), 맥스 (Max, female), 펠리시아 (Felicia), 제이미 (Jaime), 사이퍼 (Cypher), 트로프 (Trov), 바렌 (Varen), 칼리아흐 (Calliach).
- Adult register: as explicit as the source — 자지 (cock), 보지 (pussy), 엉덩이/궁둥이 (ass), 가슴/젖 (tits), 싸다 (cum), 박다/따먹다 (fuck), 클리토리스, 젖꼭지. Never soften to 성기/하체.
- Moans adapted to Korean: 아, 응, 하아, 윽; never English letters.
- Tags <color=...>/<b>: byte-identical, parameters never translated.
- One source line = one output line.

<!-- PROMPT-END -->

## 1. 표기

- 마침표는 반각 `!` `?` `,` — 한국어 출판 관행. 줄임표는 `…` 또는 `...`.
- 따옴표 “ ”, 안에 ‘ ’. 브랜드(Smutgram, CUM)는 영문 유지.
- 한글 음절 사이에 공백을 넣지 않는다.

## 2. 말투

- 반말 — 연인·친구·동급. 존댓말(해요체) — 낯선 사람·서비스. 합쇼체 — 공식.
- 장면 중간에 갑자기 존댓말로 돌아가면 오류.

## 3. 성인 어휘

| EN     | KO（보통） | KO（노골적） | 쓰지 말 것   |
| ------ | ---------- | ------------ | ------------ |
| cock   | 자지       | 좆           | 남성기       |
| pussy  | 보지       | 씹           | 질（의학）   |
| ass    | 엉덩이     | 궁둥이       | 항문（의학） |
| tits   | 가슴       | 젖           | 유방（의학） |
| cum    | 싸다       | 정액         | 사정（의학） |
| fuck   | 박다       | 따먹다       | 성교         |
| clit   | 클리토리스 | —            | —            |
| nipple | 젖꼭지     | —            | —            |

## 4. 이름

조이, 사라, 클라우디아, 리오, 로지, 레오나, 노바, 맥스(여성), 펠리시아, 제이미, 사이퍼,
트로프, 바렌, 칼리아흐.
