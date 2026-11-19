import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWav, escapeXml, clampNumber, sleep, encodeWav, int16ToFloat, floatToInt16, resampleLinear, TARGET_SAMPLE_RATE } from '../util.js';
import { applyFades, appendTailSilence } from '../normalize.js';
import { throwIfAborted, type BatchOptions, type EngineInfo, type EngineVoice, type SynthesisRequest, type TtsEngine } from './types.js';

const RATE_MIN = 0.5;
const RATE_MAX = 2.0;

/** PowerShell 输出统一 UTF-8，避免中文音色名乱码。 */
const VOICES_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$list = @()
foreach ($v in $s.GetInstalledVoices()) {
  if ($v.Enabled) {
    $info = $v.VoiceInfo
    $list += [PSCustomObject]@{ name = $info.Name; lang = $info.Culture.Name; gender = "$($info.Gender)" }
  }
}
$s.Dispose()
$list | ConvertTo-Json -Compress
`;

const SYNTH_SCRIPT = String.raw`
param([string]$JobsFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$jobs = [System.IO.File]::ReadAllText($JobsFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
foreach ($job in $jobs) {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SelectVoice($job.voice)
  $s.SetOutputToWaveFile($job.out, $fmt)
  if ($job.ssml) { $s.SpeakSsml($job.text) } else { $s.Speak($job.text) }
  $s.SetOutputToNull()
}
$s.Dispose()
Write-Output 'DONE'
`;

function runPowerShell(scriptPath: string, args: string[], signal: AbortSignal, timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new Error('操作已取消'));
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.trim() || `PowerShell 退出码 ${code}`));
    });
  });
}

async function powershellInline(script: string, signal: AbortSignal, timeoutMs = 60000): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blc-voice-'));
  try {
    const scriptPath = join(dir, 'run.ps1');
    await writeFile(scriptPath, script, 'utf8');
    return await runPowerShell(scriptPath, [], signal, timeoutMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function genderFrom(value: string): EngineVoice['gender'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'female') return 'female';
  if (normalized === 'male') return 'male';
  return 'unknown';
}

/** speed 0.5–2.0 映射为 SSML rate 百分比。 */
function ssmlRate(speed: number): number {
  return Math.round(clampNumber(speed, RATE_MIN, RATE_MAX, 1) * 100);
}

function buildSsml(text: string, lang: string, speed: number, pitch: number, volume: number): string {
  const pitchPercent = Math.round(clampNumber(pitch, -50, 50, 0));
  const volumePercent = Math.round(clampNumber(volume, 0, 200, 100));
  const prosody = [
    `rate="${ssmlRate(speed)}%"`,
    pitchPercent !== 0 ? `pitch="${pitchPercent > 0 ? '+' : ''}${pitchPercent}%"` : '',
    volumePercent !== 100 ? `volume="${volumePercent}%"` : '',
  ].filter(Boolean).join(' ');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(lang || 'zh-CN')}">` +
    `<prosody ${prosody}>${escapeXml(text)}</prosody></speak>`;
}

async function countFiles(paths: string[]): Promise<number> {
  let count = 0;
  for (const path of paths) {
    try {
      await access(path);
      count += 1;
    } catch {
      // 未生成
    }
  }
  return count;
}

interface GainState { value: number }

/**
 * SAPI 产物统一后处理：解析 PowerShell 写出的 WAV → 重采样到目标采样率 →
 * 响度归一（多音色播客响度一致）→ 首尾淡入淡出 → 段尾呼吸静音 → 重编码。
 * 一批产物共用首个片段算出的增益，段与段之间不会忽大忽小。
 */
async function polishSapiWav(wav: Buffer, gain: GainState, calibrateGain: boolean): Promise<{ durationMs: number; encoded: Buffer }> {
  const info = parseWav(wav);
  const frameBytes = info.channels * (info.bits / 8);
  const frameCount = Math.floor(info.dataBytes / frameBytes);
  const pcm = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) pcm[i] = wav.readInt16LE(info.dataOffset + i * frameBytes);
  const samples = resampleLinear(int16ToFloat(pcm), info.sampleRate, TARGET_SAMPLE_RATE);
  const rms = computeRms(samples);
  if (calibrateGain && rms > 1e-4) {
    gain.value = Math.min(4, Math.max(0.25, 0.09 / rms));
  }
  for (let i = 0; i < samples.length; i += 1) {
    const scaled = samples[i] * gain.value;
    samples[i] = scaled > 0.98 ? 0.98 : scaled < -0.98 ? -0.98 : scaled;
  }
  applyFades(samples, TARGET_SAMPLE_RATE);
  const withTail = appendTailSilence(samples, TARGET_SAMPLE_RATE);
  const encoded = encodeWav(floatToInt16(withTail), TARGET_SAMPLE_RATE);
  return { durationMs: Math.round((withTail.length * 1000) / TARGET_SAMPLE_RATE), encoded };
}

function computeRms(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / Math.max(1, samples.length));
}

export class SapiEngine implements TtsEngine {
  readonly info: EngineInfo = {
    id: 'sapi',
    displayName: 'Windows 系统音色',
    kind: 'system',
    supportsPitch: true,
    available: false,
  };
  private voicesCache: EngineVoice[] | null = null;

  private async runProbe(): Promise<EngineVoice[]> {
    const stdout = await powershellInline(VOICES_SCRIPT, AbortSignal.timeout(30000));
    const parsed = JSON.parse(stdout.trim() || '[]') as Array<{ name: string; lang: string; gender: string }>;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map(item => ({
      id: `sapi:${item.name}`,
      engineId: 'sapi',
      name: item.name,
      lang: item.lang || 'unknown',
      gender: genderFrom(item.gender),
      tags: ['系统内置', String(item.lang ?? '').startsWith('zh') ? '中文' : String(item.lang ?? '').startsWith('en') ? '英语' : '其他'],
    }));
  }

  async listVoices(): Promise<EngineVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    try {
      this.voicesCache = await this.runProbe();
      this.info.available = this.voicesCache.length > 0;
      if (!this.info.available) this.info.reason = '系统没有已安装的 TTS 音色';
    } catch (error) {
      this.info.available = false;
      this.info.reason = `无法访问 Windows SAPI：${String((error as Error).message ?? error).slice(0, 120)}`;
      this.voicesCache = [];
    }
    return this.voicesCache;
  }

  /**
   * 一个 PowerShell 进程顺序合成整批段落；Node 侧轮询产物文件数汇报进度，
   * 取消信号触发时直接杀掉子进程。
   */
  async synthesizeBatch(requests: SynthesisRequest[], options: BatchOptions): Promise<{ durationMs: number }> {
    if (requests.length === 0) return { durationMs: 0 };
    const voices = await this.listVoices();
    const known = new Set(voices.map(voice => voice.id));
    const dir = await mkdtemp(join(tmpdir(), 'blc-voice-sapi-'));
    try {
      const jobs = requests.map(request => {
        if (!known.has(request.voice.id)) throw new Error(`音色不存在：${request.voice.name}`);
        const useSsml = request.speed !== 1 || request.pitch !== 0 || request.volume !== 100;
        return {
          voice: request.voice.name.replace(/^sapi:/, ''),
          out: request.outFile,
          ssml: useSsml,
          text: useSsml
            ? buildSsml(request.text, request.voice.lang, request.speed, request.pitch, request.volume)
            : request.text,
        };
      });
      const jobsFile = join(dir, 'jobs.json');
      const scriptFile = join(dir, 'synth.ps1');
      await writeFile(jobsFile, JSON.stringify(jobs), 'utf8');
      await writeFile(scriptFile, SYNTH_SCRIPT, 'utf8');
      const signal = options.signal;
      const run = runPowerShell(scriptFile, ['-JobsFile', jobsFile], signal, 3600000);
      let settled = false;
      void run.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        throwIfAborted(signal);
        try {
          await sleep(500, signal);
        } catch {
          break; // 取消：下一轮 throwIfAborted 抛出
        }
        options.onProgress?.(await countFiles(requests.map(request => request.outFile)), requests.length);
      }
      await run;
      throwIfAborted(signal);
      const gain: GainState = { value: 1 };
      let durationMs = 0;
      for (let i = 0; i < requests.length; i += 1) {
        const request = requests[i];
        const wav = await readFile(request.outFile);
        let info;
        try {
          info = parseWav(wav);
        } catch {
          throw new Error(`音色「${request.voice.name}」没有产出有效音频（常见原因：音色语言与文本不匹配），请更换音色`);
        }
        if (info.dataBytes === 0) {
          throw new Error(`音色「${request.voice.name}」对「${request.text.slice(0, 12)}…」没有读出声音，常见原因是音色语言与文本不匹配，请更换匹配语言的音色`);
        }
        const polished = await polishSapiWav(wav, gain, i === 0);
        await writeFile(request.outFile, polished.encoded);
        durationMs += polished.durationMs;
      }
      options.onProgress?.(requests.length, requests.length);
      return { durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async synthesize(request: SynthesisRequest): Promise<{ durationMs: number }> {
    return this.synthesizeBatch([request], { signal: request.signal });
  }

  dispose(): void {
    this.voicesCache = null;
  }
}
