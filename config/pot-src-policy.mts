/**
 * pot-src-policy.mts — ИСТОЧНИК ИСТИНЫ: отбор POT по провенансу.
 *
 * `exclude` — метки `#. src:`, не попадающие в POT (точная метка или префикс
 * с `*`); `include` — что допускается (`*` = всё). Исключённые записи не
 * теряются: они уходят в `tmp/pot-excluded.jsonl`. Обоснование и цифры —
 * docs/pot-provenance.md.
 *
 * JSON-артефакт `config/pot-src-policy.json` читает potgen (Rust) и TS-проверки;
 * руками он не правится. После правки:
 *   node config/pot-src-policy.mts > config/pot-src-policy.json
 * Равенство стережёт `config/pot-src-policy.test.mts`.
 */
import process from "node:process";

import { renderJson } from "./emit.mts";

export interface SrcPolicyConfig {
  readonly _comment: string;
  readonly exclude: readonly string[];
  readonly include: readonly string[];
}

export const POT_SRC_POLICY = {
  _comment:
    "Политика отбора POT по провенансу: exclude — метки #. src:, не попадающие в POT (точные или префикс с *), include — что допускается (* = всё). Исключённые записи уходят в tmp/pot-excluded.jsonl. Обоснование и цифры — docs/pot-provenance.md. 2026-11-23: срез исключительно ассетных типов (имена объектов, аудио, шейдеров, анимаций, костей, полей) — 7953 записи; проверено, что ни одна такая строка не доставляется живым источником (0 пересечений с сырьём дампа).",
  exclude: [
    "raw:Font",
    "raw:Mesh",
    "raw:MonoScript",
    "raw:Texture2D",
    "raw:Sprite",
    "raw:TextAsset",
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
  ],
  include: ["*"],
} as const satisfies SrcPolicyConfig;

if (import.meta.filename === process.argv[1]) {
  process.stdout.write(await renderJson(POT_SRC_POLICY));
}
