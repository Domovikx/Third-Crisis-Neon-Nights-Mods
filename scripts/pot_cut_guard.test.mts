/**
 * pot_cut_guard.test.mts — страховка на срез POT по провенансу.
 *
 * Владелец: «здесь большой момент, где может быть ошибка — не хочется случайно
 * что-то нужное выкинуть». Поэтому три уровня защиты:
 *
 *   1. СОСТАВ политики сверяется со списком, проверенным человеком. Добавил
 *      кто-то новую метку в `config/pot-src-policy.json` — тест падает и
 *      заставляет подтвердить решение, а не «протащить» его молча.
 *   2. ЗАПРЕЩЁННЫЕ метки: источники настоящего текста не могут попасть в
 *      exclude никогда — отдельная проверка, чтобы список не «поплыл».
 *   3. РЕАЛЬНЫЙ ДАМП (opt-in): ни одна строка, доставленная разрешённым
 *      источником, не должна отсутствовать в POT. Это проверка смысла, а не
 *      формы: именно она ловит «ассет перебил диалог при дедупе».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { scanDump } from "../.opencode/skills/extract-text/scripts/inventory.mts";
import { parsePo } from "../.opencode/skills/extract-text/scripts/po_file.mts";
import {
  discoverPolicyPath,
  loadSrcPolicy,
  policyDecision,
  type SrcPolicy,
} from "../.opencode/skills/extract-text/scripts/pot_rules.mts";

const REPO = resolve(import.meta.dirname, "..");
const POT = join(REPO, "po", "template.pot");
const DUMP = process.env.TCNN_DUMP_DIR ?? join(REPO, "tmp", "dump-after");

/** Список, проверенный человеком 2026-11-23 (`docs/pot-provenance.md`). */
const REVIEWED_EXCLUDE = [
  // Ранее исключённые (2026-11-22)
  "raw:Font",
  "raw:Mesh",
  "raw:MonoScript",
  "raw:Texture2D",
  "raw:Sprite",
  "raw:TextAsset",
  // Срез ассетных типов (2026-11-23)
  "raw:GameObject",
  "raw:AudioClip",
  "raw:Shader",
  "raw:Material",
  "raw:AnimatorController",
  "raw:AnimationClip",
  "raw:SpriteAtlas",
  "raw:AssetBundle",
  "raw:AudioMixerController",
  "raw:ComputeShader",
  "raw:RenderTexture",
  "raw:VisualEffect",
  "raw:VisualEffectAsset",
  "raw:VideoClip",
  "raw:PhysicMaterial",
  "raw:CustomRenderTexture",
  "raw:ShaderVariantCollection",
  "field:m_Name",
  "field:m_ClassName",
  "field:boneName",
  "field:m_PackedSpriteNamesToIndex",
  "field:m_AtlasTags",
  "field:m_Namespace",
  "field:m_FontNames",
  "field:ArtistName",
  "field:ArtistURL",
  "field:m_AssemblyName",
  "field:FadeOutBoolName",
  "field:category",
  "field:slotName",
  "field:UnknownName",
  "field:Name",
];

/** Метки настоящего текста: их нельзя исключать никогда. */
const FORBIDDEN = [
  "dialog",
  "bundle",
  "settings",
  "us",
  "field:m_text", // поле самой TMP-компоненты — это показываемый текст
  "field:UseText", // подпись действия ("Use")
  "field:TakenFromInventoryText", // подставляется в пресет инвентаря
  "field:DisplayName", // подписи в UI
  "field:fsm", // PlayMaker-строки
];

function loadPolicy(): SrcPolicy {
  const path = discoverPolicyPath(REPO);
  assert.ok(path, "config/pot-src-policy.json не найден");
  return loadSrcPolicy(path, { required: true }) as SrcPolicy;
}

test("состав политики совпадает с проверенным списком", () => {
  const policy = loadPolicy();
  assert.deepEqual(policy.exclude, REVIEWED_EXCLUDE, "политика изменилась — подтверди решение");
});

test("настоящий текст никогда не исключается", () => {
  const policy = loadPolicy();
  for (const src of FORBIDDEN) {
    assert.ok(
      !policy.exclude.includes(src),
      `метка ${src} доставляет настоящий текст и не может быть в exclude`,
    );
    assert.equal(
      policyDecision(policy, src).excluded,
      false,
      `решение по ${src} обязано быть «оставить»`,
    );
  }
});

test("пути, которые режем, действительно ассетные (не текст)", () => {
  const policy = loadPolicy();
  for (const src of policy.exclude) {
    assert.match(src, /^(raw|field):/, `${src}: исключать можно только raw-классы и поля-ассеты`);
  }
});

test("реальный дамп: текст разрешённых источников не потерян (opt-in)", async (t) => {
  if (!existsSync(DUMP) || !existsSync(POT)) {
    t.skip(`нет ${DUMP} или ${POT}`);
    return;
  }
  const policy = loadPolicy();
  const { items } = await scanDump(DUMP);
  const potTexts = new Set(
    parsePo(readFileSync(POT, "utf8"))
      .filter((e) => e.msgid)
      .map((e) => e.msgid),
  );

  const allowed = items.filter((i) => !policyDecision(policy, i.src).excluded);
  const missing = allowed.filter((i) => !potTexts.has(i.text));
  const examples = missing
    .slice(0, 10)
    .map((i) => `${i.src}: ${JSON.stringify(i.text.slice(0, 60))}`);
  t.diagnostic(
    `разрешённых элементов дампа: ${allowed.length}, POT-записей: ${potTexts.size}, потеряно: ${missing.length}`,
  );
  assert.equal(missing.length, 0, `потерян текст:\n${examples.join("\n")}`);
});
