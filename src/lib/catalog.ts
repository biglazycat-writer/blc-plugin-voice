import type { EngineVoice } from './engines/types.js';

export type ModelFamily = 'vits' | 'kokoro';

export interface SpeakerLabel {
  name: string;
  lang: string;
  gender: EngineVoice['gender'];
}

export interface CatalogModel {
  id: string;
  family: ModelFamily;
  displayName: string;
  langs: string[];
  /** 下载包近似大小（字节），以 GitHub 返回的 Content-Length 为准。 */
  sizeBytes: number;
  url: string;
  /** 说话人数（估计值；首次加载模型后会以真实值写入 meta.json）。 */
  speakers: number;
  /** 已知的说话人名称（下标 = sid）；未知用通用标签。 */
  speakerNames?: string[];
  /** 按说话人区间给名字/语言/性别（kokoro v1.1 的官方分组）。 */
  speakerRanges?: Array<{ from: number; to: number; render: (index: number) => SpeakerLabel }>;
  quality: 'standard' | 'high';
  /** 真人感优先推荐：音质最接近真人的旗舰模型。 */
  recommended?: boolean;
  note: string;
}

export function speakerLabelFor(model: CatalogModel, sid: number): SpeakerLabel {
  const named = model.speakerNames?.[sid];
  if (named) return { name: named, lang: model.langs[0] ?? 'zh', gender: 'unknown' };
  if (model.speakerRanges) {
    for (const range of model.speakerRanges) {
      if (sid >= range.from && sid <= range.to) return range.render(sid - range.from);
    }
  }
  return {
    name: model.family === 'kokoro' ? `音色 ${sid + 1}` : `说话人 ${sid + 1}`,
    lang: model.langs[0] ?? 'zh',
    gender: 'unknown',
  };
}

/**
 * 内置模型目录：全部为 k2-fsa/sherpa-onnx 官方发布的本地模型，
 * 下载后完全离线推理。URL 已逐个用 HEAD 请求核对存在与大小。
 * 排序即展示顺序：想要"真人感"优先下载前面的模型。
 */
/**
 * kokoro-multi-lang-v1_1 的说话人分组（来源：k2-fsa/sherpa-onnx PR #1942）：
 * 0–2 英语女声 3 人，3–57 中文女声 55 人，58–102 中文男声 45 人。
 */
const KOKORO_V11_RANGES: CatalogModel['speakerRanges'] = [
  {
    from: 0, to: 2,
    render: index => ({ name: ['英语女声 af_maple', '英语女声 af_sol', '英语女声 bf_vale'][index] ?? `英语女声 #${index + 1}`, lang: 'en', gender: 'female' }),
  },
  {
    from: 3, to: 57,
    render: index => ({ name: `中文女声 #${String(index + 1).padStart(2, '0')}`, lang: 'zh', gender: 'female' }),
  },
  {
    from: 58, to: 102,
    render: index => ({ name: `中文男声 #${String(index + 1).padStart(2, '0')}`, lang: 'zh', gender: 'male' }),
  },
];

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'kokoro-multi-lang-v1_1',
    family: 'kokoro',
    displayName: 'Kokoro 多语言 v1.1 完整版 · 103 音色',
    langs: ['zh', 'en', 'ja', 'ko'],
    sizeBytes: 364_900_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
    speakers: 103,
    speakerRanges: KOKORO_V11_RANGES,
    quality: 'high',
    recommended: true,
    note: '首选：完整精度，音质上限最高；实测 CPU 合成约 1.1× 实时（Windows）。包体较大，建议网络好时下载。',
  },
  {
    id: 'kokoro-int8-multi-lang-v1_1',
    family: 'kokoro',
    displayName: 'Kokoro 多语言 v1.1 int8 · 103 音色',
    langs: ['zh', 'en', 'ja', 'ko'],
    sizeBytes: 147_100_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2',
    speakers: 103,
    speakerRanges: KOKORO_V11_RANGES,
    quality: 'high',
    recommended: true,
    note: '量化版：体积和内存减半，适合先装起来体验；实测 CPU 合成约 0.3× 实时，比完整版慢约 3 倍，长文朗读请优先完整版。',
  },
  {
    id: 'vits-melo-tts-zh_en',
    family: 'vits',
    displayName: 'Melo 中英双语 · 双说话人',
    langs: ['zh', 'en'],
    sizeBytes: 167_100_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2',
    speakers: 2,
    speakerNames: ['中文女声', '英语女声'],
    quality: 'high',
    recommended: true,
    note: '比 Kokoro 小一半，中英混合文本表现好，播客双人对谈常用。',
  },
  {
    id: 'vits-zh-hf-keqing',
    family: 'vits',
    displayName: '刻晴 · 高质量中文女声',
    langs: ['zh'],
    sizeBytes: 120_600_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-keqing.tar.bz2',
    speakers: 1,
    speakerNames: ['刻晴'],
    quality: 'high',
    recommended: true,
    note: '单音色但语调自然，长文朗读首选之一。',
  },
  {
    id: 'vits-zh-hf-theresa',
    family: 'vits',
    displayName: '德丽莎 · 高质量中文女声',
    langs: ['zh'],
    sizeBytes: 120_600_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-theresa.tar.bz2',
    speakers: 1,
    speakerNames: ['德丽莎'],
    quality: 'high',
    note: '单音色，语速沉稳。',
  },
  {
    id: 'vits-zh-hf-fanchen-C',
    family: 'vits',
    displayName: '凡尘 C · 中文男声',
    langs: ['zh'],
    sizeBytes: 119_300_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-fanchen-C.tar.bz2',
    speakers: 1,
    speakerNames: ['凡尘 C'],
    quality: 'standard',
    note: '男声选项。',
  },
  {
    id: 'vits-icefall-zh-aishell3',
    family: 'vits',
    displayName: 'Aishell3 中文 · 174 人多音色',
    langs: ['zh'],
    sizeBytes: 31_600_000,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2',
    speakers: 174,
    quality: 'standard',
    note: '体积最小、音色最多，但原生 8kHz（电话音质），对音质有要求请选上面的模型。',
  },
];

export function findCatalogModel(modelId: string): CatalogModel | undefined {
  return MODEL_CATALOG.find(model => model.id === modelId);
}

/** 目录中的估计音色列表（模型加载后以 meta.json 的真实数量为准）。 */
export function catalogVoicesForModel(model: CatalogModel, engineId: string): EngineVoice[] {
  const count = Math.max(1, model.speakers);
  const voices: EngineVoice[] = [];
  for (let sid = 0; sid < count; sid += 1) {
    const label = speakerLabelFor(model, sid);
    voices.push({
      id: `${engineId}:${model.id}:${sid}`,
      engineId,
      name: label.name,
      lang: label.lang,
      gender: label.gender,
      tags: [model.displayName, ...model.langs],
      modelId: model.id,
      speakerId: sid,
    });
  }
  return voices;
}
