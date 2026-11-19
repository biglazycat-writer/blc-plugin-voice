import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWav, clampNumber } from '../util.js';
import { throwIfAborted, type EngineInfo, type EngineVoice, type SynthesisRequest, type TtsEngine } from './types.js';

const execFileAsync = promisify(execFile);

/** espeak-ng `-s` 单位同样是 wpm，默认 175。 */
const BASE_WPM = 175;

interface EspeakVoiceLine {
  name: string;
  lang: string;
  gender: EngineVoice['gender'];
}

function parseEspeakVoices(stdout: string): EspeakVoiceLine[] {
  const voices: EspeakVoiceLine[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // 格式：Idx  Language  Age/Gender  VoiceName  File  Other Languages
    const columns = line.split(/\s+/);
    if (columns.length < 5 || columns[0] !== '0' && Number.isNaN(Number(columns[0]))) continue;
    const genderCell = columns[2] ?? '';
    voices.push({
      name: columns[3],
      lang: columns[1].split('-')[0],
      gender: /female/i.test(genderCell) ? 'female' : /male/i.test(genderCell) ? 'male' : 'unknown',
    });
  }
  return voices;
}

export class EspeakEngine implements TtsEngine {
  readonly info: EngineInfo = {
    id: 'espeak',
    displayName: 'espeak-ng',
    kind: 'system',
    supportsPitch: false,
    available: false,
  };
  private voicesCache: EngineVoice[] | null = null;

  async listVoices(): Promise<EngineVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    try {
      const { stdout } = await execFileAsync('espeak-ng', ['--voices'], { timeout: 15000, maxBuffer: 1024 * 1024 });
      this.voicesCache = parseEspeakVoices(stdout).map(item => ({
        id: `espeak:${item.name}`,
        engineId: 'espeak',
        name: item.name,
        lang: item.lang,
        gender: item.gender,
        tags: ['开源', item.lang.startsWith('zh') ? '中文' : '其他'],
      }));
      this.info.available = this.voicesCache.length > 0;
      if (!this.info.available) this.info.reason = 'espeak-ng 没有列出可用音色';
    } catch (error) {
      this.info.available = false;
      this.info.reason = '未检测到 espeak-ng，请先安装';
      void error;
      this.voicesCache = [];
    }
    return this.voicesCache;
  }

  async synthesize(request: SynthesisRequest): Promise<{ durationMs: number }> {
    const voices = await this.listVoices();
    if (!voices.some(voice => voice.id === request.voice.id)) throw new Error(`音色不存在：${request.voice.name}`);
    throwIfAborted(request.signal);
    const wpm = Math.max(80, Math.round(BASE_WPM * clampNumber(request.speed, 0.5, 2, 1)));
    // espeak-ng 的 -a 幅度取值 0–200、默认 100 即正常响度，与 volume 语义（0–200、100 不变）一致。
    const volumeArg = clampNumber(Math.round(request.volume), 0, 200, 100);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('espeak-ng', ['-v', request.voice.name.replace(/^espeak:/, ''), '-s', String(wpm), '-a', String(volumeArg), '-w', request.outFile, '--', request.text], { stdio: 'ignore' });
      const onAbort = () => child.kill();
      request.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', reject);
      child.on('close', code => {
        request.signal.removeEventListener('abort', onAbort);
        if (request.signal.aborted) return reject(new Error('操作已取消'));
        if (code === 0) return resolve();
        reject(new Error(`espeak-ng 退出码 ${code}`));
      });
    });
    const { readFile } = await import('node:fs/promises');
    const wav = await readFile(request.outFile);
    return { durationMs: parseWav(wav).durationMs };
  }

  dispose(): void {
    this.voicesCache = null;
  }
}
