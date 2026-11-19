/**
 * 中文朗读文本归一化：把数字、日期、百分比等写成 TTS 能自然读出的汉字。
 * 神经模型（尤其 vits/lexicon 系列）对阿拉伯数字的读法不可控，
 * 先归一成汉字能显著提升"真人感"和正确率。只处理明显的 zh 语境，不碰英文单词内的数字。
 */

const ZH_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const ZH_UNITS = ['', '十', '百', '千'];
const ZH_GROUP_UNITS = ['', '万', '亿', '万亿'];

/** 整数 → 中文读法；超过 12 位或难以分组的按逐位读。 */
export function integerToZh(value: string): string {
  const digits = value.replace(/^0+(?=\d)/, '');
  if (digits.length === 0 || Number(digits) === 0) return '零';
  if (digits.length >= 13) return digits.split('').map(d => ZH_DIGITS[Number(d)]).join('');
  // 按四位一组从低位切：12_3456_7890 → 12 / 3456 / 7890
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.push(digits.slice(Math.max(0, end - 4), end));
  }
  let out = '';
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const group = groups[g];
    const groupValue = Number(group);
    if (groupValue === 0) {
      // 整组为零只补一个零（避免 连续零/结尾零）
      if (out && !out.endsWith('零')) out += '零';
      continue;
    }
    const unit = ZH_GROUP_UNITS[g] ?? '';
    out += groupToZh(group) + unit;
    if (g > 0 && groupValue < 1000 && !out.endsWith('零')) out += '零';
  }
  return out.replace(/零+$/, '').replace(/零{2,}/g, '零');
}

function groupToZh(group: string): string {
  let out = '';
  const length = group.length;
  for (let i = 0; i < length; i += 1) {
    const digit = Number(group[i]);
    const unitIndex = length - i - 1;
    if (digit === 0) {
      if (out && !out.endsWith('零')) out += '零';
      continue;
    }
    out += ZH_DIGITS[digit] + ZH_UNITS[unitIndex];
  }
  // 「一十X」口语读「十X」
  return out.replace(/^一十/, '十').replace(/零+$/, '');
}

function decimalToZh(value: string): string {
  const [intPart, fracPart] = value.split('.');
  const intZh = integerToZh(intPart);
  if (!fracPart) return intZh;
  return `${intZh}点${fracPart.split('').map(d => ZH_DIGITS[Number(d)] ?? d).join('')}`;
}

/** 仅当数字嵌在拉丁词/编号里（字母、数字或连字符紧贴）时才跳过：iPhone 15、UTF-8、A4 纸。
 * 空格分隔的数字（如「iPhone 15 很好用」）按中文习惯读成「十五」。 */
function isZhContext(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? '';
  const after = text[end] ?? '';
  const attached = /[A-Za-z0-9-]/;
  return !attached.test(before) && !attached.test(after);
}

const DATE_PATTERN = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/g;
const TIME_PATTERN = /(\d{1,2}):(\d{2})/g;
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/g;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;

/** 对中文文本做朗读归一化；没有数字或非中文语境时原样返回。 */
export function normalizeZhReadingText(text: string): string {
  if (!/\d/.test(text)) return text;
  let out = text;
  out = out.replace(DATE_PATTERN, (_match, year, month, day) =>
    `${digitRead(year)}年${integerToZh(month)}月${integerToZh(day)}日`);
  out = out.replace(TIME_PATTERN, (_match, hour, minute) =>
    `${integerToZh(hour)}点${minute === '00' ? '整' : integerToZh(minute) + '分'}`);
  out = out.replace(PERCENT_PATTERN, (_match, value) => `百分之${decimalToZh(value)}`);
  // 主数字替换：只在中文语境里逐个替换。
  out = out.replace(NUMBER_PATTERN, (match, offset: number) => {
    if (!isZhContext(out, offset, offset + match.length)) return match;
    if (match.length === 4 && /年|届|款|级|期/.test(out[offset + match.length] ?? '')) {
      return digitRead(match); // 2024年 → 二零二四年
    }
    return decimalToZh(match);
  });
  return out;
}

/** 逐位读（年份、编号、手机号风格）。 */
export function digitRead(value: string): string {
  return value.split('').map(d => ZH_DIGITS[Number(d)] ?? d).join('');
}

// ---------- 拟人化音频后处理 ----------

/** 段落响度归一到统一目标 RMS，压制忽大忽小的"机器人感"。 */
export function normalizeLoudness(samples: Float32Array, targetRms = 0.09, maxGain = 4): Float32Array {
  if (samples.length === 0) return samples;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) sumSquares += samples[i] * samples[i];
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < 1e-4) return samples; // 近静音不放大噪声
  const gain = Math.min(maxGain, Math.max(0.25, targetRms / rms));
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] * gain;
    samples[i] = value > 0.98 ? 0.98 : value < -0.98 ? -0.98 : value;
  }
  return samples;
}

/** 首尾淡入淡出，消除段落边界的咔哒声。 */
export function applyFades(samples: Float32Array, sampleRate: number, fadeInMs = 12, fadeOutMs = 28): Float32Array {
  const fadeIn = Math.min(Math.round((sampleRate * fadeInMs) / 1000), Math.floor(samples.length / 2));
  const fadeOut = Math.min(Math.round((sampleRate * fadeOutMs) / 1000), Math.floor(samples.length / 2));
  for (let i = 0; i < fadeIn; i += 1) samples[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i += 1) {
    samples[samples.length - 1 - i] *= i / fadeOut;
  }
  return samples;
}

/** 段尾补一小段"呼吸"静音，让连播更自然。 */
export function appendTailSilence(samples: Float32Array, sampleRate: number, silenceMs = 110): Float32Array {
  const tail = Math.round((sampleRate * silenceMs) / 1000);
  if (tail <= 0) return samples;
  const out = new Float32Array(samples.length + tail);
  out.set(samples);
  return out;
}
