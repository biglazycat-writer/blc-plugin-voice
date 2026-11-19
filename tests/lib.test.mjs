import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoParagraphs } from '../dist/lib/splitter.js';
import { encodeWav, parseWav, concatWavs, resampleLinear, floatToInt16, int16ToFloat, silenceSamples, sha256, sanitizeId, clampNumber, escapeXml, TARGET_SAMPLE_RATE } from '../dist/lib/util.js';
import { extractJsonArray } from '../dist/lib/ai-text.js';
import { buildFallbackScript, replaceLines, LINE_PAUSE_MS } from '../dist/lib/podcast.js';
import { MODEL_CATALOG, speakerLabelFor, findCatalogModel } from '../dist/lib/catalog.js';
import { DEFAULT_SETTINGS } from '../dist/lib/settings.js';
import { integerToZh, digitRead, normalizeZhReadingText, normalizeLoudness, applyFades, appendTailSilence } from '../dist/lib/normalize.js';

test('Markdown 切分：跳过代码块与表格，标题独立成段', () => {
  const markdown = [
    '---',
    'title: 测试',
    '---',
    '',
    '# 第一章 开始',
    '',
    '这是第一段，**加粗**和[链接](https://example.com)都会被剥掉。',
    '',
    '```js',
    'const x = 1; // 代码不朗读',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- 列表项甲',
    '- 列表项乙',
    '',
    '最后一段。',
  ].join('\n');
  const paragraphs = splitIntoParagraphs(markdown);
  const texts = paragraphs.map(p => p.text);
  assert.equal(texts[0], '第一章 开始');
  assert.equal(texts[1], '这是第一段，加粗和链接都会被剥掉。');
  assert.ok(texts.includes('列表项甲'));
  assert.ok(texts.includes('列表项乙'));
  assert.equal(texts.at(-1), '最后一段。');
  assert.ok(!texts.some(text => text.includes('const x') || text.includes('列A')));
  for (const paragraph of paragraphs) {
    assert.equal(paragraph.index, paragraphs.indexOf(paragraph));
    assert.equal(paragraph.chars, paragraph.text.length);
  }
});

test('长段落按句子边界拆分到上限以内', () => {
  const text = Array.from({ length: 30 }, (_, i) => `这是第${i}个句子，内容比较长一些。`).join('');
  const paragraphs = splitIntoParagraphs(text, 120);
  assert.ok(paragraphs.length >= 4);
  for (const paragraph of paragraphs) {
    assert.ok(paragraph.chars <= 120, `段落超长：${paragraph.chars}`);
    assert.ok(paragraph.text.endsWith('。'));
  }
});

test('WAV 编解码与拼接：块遍历兼容扩展头', () => {
  const samples = new Int16Array(2205);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(Math.sin(i / 20) * 20000);
  const wav = encodeWav(samples, 22050);
  const info = parseWav(wav);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.channels, 1);
  assert.equal(info.bits, 16);
  assert.equal(info.dataBytes, 4410);
  assert.equal(info.durationMs, 100);
  const merged = concatWavs([wav, wav, wav]);
  assert.equal(merged.pcm.length, 2205 * 3);
  assert.equal(merged.durationMs, 300);
  assert.throws(() => parseWav(Buffer.from('not a wav file at all............', 'utf8')));
});

test('重采样与静音段：24k 转 22.05k 长度正确', () => {
  const samples = new Float32Array(24000);
  const resampled = resampleLinear(samples, 24000, 22050);
  assert.equal(resampled.length, 22050);
  const back = resampleLinear(resampled, 22050, 24000);
  assert.equal(back.length, 24000);
  const silence = silenceSamples(22050, 420);
  assert.equal(silence.length, Math.round((22050 * 420) / 1000));
  assert.equal(LINE_PAUSE_MS, 420);
  const floats = int16ToFloat(floatToInt16(new Float32Array([0.5, -0.5, 1.5])));
  assert.ok(floats[0] > 0.49 && floats[0] < 0.51);
  assert.ok(floats[2] > 0.99 && floats[2] <= 1); // 满幅经 16bit 量化后略小于 1
});

test('AI 生成文本中的 JSON 数组提取', () => {
  const fenced = '好的，这是脚本：\n```json\n[{"speaker":"host","text":"开场"},{"speaker":"guest","text":"回应，带逗号"}]\n```';
  const array = extractJsonArray(fenced);
  assert.equal(array?.length, 2);
  assert.deepEqual(array?.[0], { speaker: 'host', text: '开场' });
  const raw = '前缀说明 [ {"speaker":"host","text":"只有一行"}, ] 后缀';
  assert.equal(extractJsonArray(raw)?.length, 1);
  assert.equal(extractJsonArray('完全不是 JSON'), null);
});

test('本地规则播客脚本：覆盖开场收尾，长度受分钟数约束', () => {
  const paragraphs = Array.from({ length: 8 }, (_, i) => `第${i + 1}段的正文内容足够长，可以成为一期节目的要点，这里放一些具体的观点和例子。`);
  const duet = buildFallbackScript('测试文章', paragraphs, 'duet', 3);
  assert.equal(duet.lines[0].speaker, 'host');
  assert.equal(duet.lines.at(-1).speaker, 'host');
  assert.ok(duet.lines.some(line => line.speaker === 'guest'));
  assert.ok(duet.lines.length <= 200);
  const solo = buildFallbackScript('测试文章', paragraphs, 'solo', 1);
  assert.ok(solo.lines.every(line => line.speaker === 'host'));
  const sanitized = replaceLines(duet, [
    { speaker: 'host', text: '新的开场' },
    { speaker: 'guest', text: '' }, // 空台词被剔除
    { speaker: 'bad', text: '无效说话人' },
    { speaker: 'guest', text: '新回应' },
  ]);
  assert.deepEqual(sanitized.lines.map(line => line.text), ['新的开场', '新回应']);
});

test('Kokoro v1.1 说话人分组：英文/中文女声/中文男声区间', () => {
  const model = findCatalogModel('kokoro-int8-multi-lang-v1_1');
  assert.ok(model, 'int8 kokoro 应在目录中');
  assert.equal(speakerLabelFor(model, 0).lang, 'en');
  assert.equal(speakerLabelFor(model, 0).gender, 'female');
  assert.match(speakerLabelFor(model, 3).name, /中文女声 #01/);
  assert.equal(speakerLabelFor(model, 3).lang, 'zh');
  assert.equal(speakerLabelFor(model, 57).gender, 'female');
  assert.match(speakerLabelFor(model, 58).name, /中文男声 #01/);
  assert.equal(speakerLabelFor(model, 58).gender, 'male');
  assert.match(speakerLabelFor(model, 102).name, /中文男声 #45/);
  // 未知模型仍给通用标签
  assert.match(speakerLabelFor({ ...model, speakerRanges: undefined }, 5).name, /音色 6/);
});

test('模型目录：URL 合法、大小合理、ID 唯一，推荐模型排在最前', () => {  const ids = new Set();
  for (const model of MODEL_CATALOG) {
    ids.add(model.id);
    assert.match(model.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
    assert.ok(model.sizeBytes > 1_000_000 && model.sizeBytes < 1_500_000_000, `${model.id} 大小可疑`);
    assert.ok(model.speakers >= 1);
    assert.ok(['vits', 'kokoro'].includes(model.family));
    assert.equal(model.displayName.length > 0, true);
  }
  assert.equal(ids.size, MODEL_CATALOG.length);
  assert.equal(MODEL_CATALOG[0].recommended, true, '首位模型应标记推荐');
  assert.equal(MODEL_CATALOG[0].family, 'kokoro');
});

test('默认设置与工具函数', () => {
  assert.equal(DEFAULT_SETTINGS.version, 1);
  assert.equal(DEFAULT_SETTINGS.defaults.speed, 1);
  assert.equal(sanitizeId('ok-id_1.2'), 'ok-id_1.2');
  assert.equal(sanitizeId('../escape'), '');
  assert.equal(sanitizeId(''), '');
  assert.equal(clampNumber(5, 0, 2, 1), 2);
  assert.equal(clampNumber('x', 0, 2, 1), 1);
  assert.equal(escapeXml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(TARGET_SAMPLE_RATE, 24000, '目标采样率与 Kokoro 原生一致');
});

test('中文数字：整数、逐位、小数读法', () => {
  assert.equal(integerToZh('0'), '零');
  assert.equal(integerToZh('10'), '十');
  assert.equal(integerToZh('15'), '十五');
  assert.equal(integerToZh('105'), '一百零五');
  assert.equal(integerToZh('1024'), '一千零二十四');
  assert.equal(integerToZh('2024'), '二千零二十四');
  assert.equal(integerToZh('100200'), '十万零二百');
  assert.equal(integerToZh('100000000'), '一亿');
  assert.equal(integerToZh('10001'), '一万零一');
  assert.equal(digitRead('2024'), '二零二四');
});

test('中文朗读归一化：年份/日期/时间/百分比/数字/英文语境', () => {
  assert.equal(normalizeZhReadingText('2024年发布'), '二零二四年发布');
  assert.equal(normalizeZhReadingText('2024-11-18 更新完成'), '二零二四年十一月十八日 更新完成');
  assert.equal(normalizeZhReadingText('会议在12:30开始'), '会议在十二点三十分开始');
  assert.equal(normalizeZhReadingText('增长50%'), '增长百分之五十');
  assert.equal(normalizeZhReadingText('价格是3.5万元'), '价格是三点五万元');
  assert.equal(normalizeZhReadingText('共1024个用户'), '共一千零二十四个用户');
  assert.equal(normalizeZhReadingText('iPhone 15 很好用'), 'iPhone 十五 很好用', '空格分隔的数字按中文习惯读');
  assert.equal(normalizeZhReadingText('文件编码是UTF-8格式'), '文件编码是UTF-8格式', '紧贴字母和连字符的编号不动');
  assert.equal(normalizeZhReadingText('没有数字的一句话'), '没有数字的一句话');
  assert.equal(normalizeZhReadingText('错误码是404，请重试'), '错误码是四百零四，请重试');
});

test('拟人化音频后处理：响度归一、淡入淡出、呼吸静音', () => {
  const sampleRate = TARGET_SAMPLE_RATE;
  const quiet = new Float32Array(sampleRate);
  for (let i = 0; i < quiet.length; i += 1) quiet[i] = Math.sin(i / 20) * 0.05;
  const normalized = normalizeLoudness(Float32Array.from(quiet));
  let sumSquares = 0;
  for (const value of normalized) sumSquares += value * value;
  const rms = Math.sqrt(sumSquares / normalized.length);
  assert.ok(rms > 0.06 && rms < 0.13, `归一后 RMS 应接近 0.09：${rms.toFixed(4)}`);

  const silent = normalizeLoudness(new Float32Array(sampleRate));
  assert.ok(silent.every(value => value === 0), '静音段不放大噪声');

  const peak = 0.8;
  const signal = new Float32Array(sampleRate);
  signal.fill(peak);
  applyFades(signal, sampleRate);
  assert.ok(signal[0] < 0.05 && signal[sampleRate - 1] < 0.05, '首尾应淡出到接近零');
  assert.ok(Math.abs(signal[Math.floor(sampleRate / 2)] - peak) < 1e-6, '中段保持原幅度');

  const withTail = appendTailSilence(signal, sampleRate, 110);
  assert.equal(withTail.length, signal.length + Math.round((sampleRate * 110) / 1000));
  assert.ok(withTail.slice(signal.length).every(value => value === 0));
});
