/**
 * unity_classes.mts — ClassID → имя (как `obj.type.name` в UnityPy).
 *
 * В JSONL поле `type` пишется строкой, поэтому нужна таблица имён. Здесь
 * только классы, которые реально встречаются в ассетах игры (замер по всем
 * 163 файлам, 2026-11-22), — полный список Unity не нужен (KISS).
 *
 * Для неизвестного id — `ClassID<id>`: молча подставлять «Unknown» нельзя,
 * иначе потеря класса не видна в диффе.
 */

const CLASS_NAMES: Record<number, string> = {
  1: "GameObject",
  4: "Transform",
  20: "Camera",
  21: "Material",
  23: "MeshRenderer",
  28: "Texture2D",
  33: "MeshFilter",
  43: "Mesh",
  48: "Shader",
  49: "TextAsset",
  54: "Rigidbody",
  64: "MeshCollider",
  65: "BoxCollider",
  72: "ComputeShader",
  74: "AnimationClip",
  81: "AudioListener",
  82: "AudioSource",
  83: "AudioClip",
  84: "RenderTexture",
  86: "CustomRenderTexture",
  91: "AnimatorController",
  95: "Animator",
  104: "RenderSettings",
  114: "MonoBehaviour",
  115: "MonoScript",
  120: "LineRenderer",
  124: "FlareLayer",
  128: "Font",
  134: "PhysicMaterial",
  135: "SphereCollider",
  136: "CapsuleCollider",
  137: "SkinnedMeshRenderer",
  142: "AssetBundle",
  143: "CharacterController",
  150: "PreloadData",
  157: "LightmapSettings",
  164: "AudioReverbFilter",
  165: "AudioHighPassFilter",
  167: "AudioReverbZone",
  169: "AudioLowPassFilter",
  196: "NavMeshSettings",
  198: "ParticleSystem",
  199: "ParticleSystemRenderer",
  200: "ShaderVariantCollection",
  212: "SpriteRenderer",
  213: "Sprite",
  221: "AnimatorOverrideController",
  222: "CanvasRenderer",
  223: "Canvas",
  224: "RectTransform",
  225: "CanvasGroup",
  241: "AudioMixerController",
  243: "AudioMixerGroupController",
  245: "AudioMixerSnapshotController",
  320: "PlayableDirector",
  328: "VideoPlayer",
  329: "VideoClip",
  331: "SpriteMask",
  73398921: "VFXRenderer",
  687078895: "SpriteAtlas",
  850595691: "LightingSettings",
  1971053207: "SpriteShapeRenderer",
  2058629509: "VisualEffectAsset",
  2083052967: "VisualEffect",
};

/** Имя класса Unity по ClassID. */
export function unityClassName(classId: number): string {
  return CLASS_NAMES[classId] ?? `ClassID${classId}`;
}
