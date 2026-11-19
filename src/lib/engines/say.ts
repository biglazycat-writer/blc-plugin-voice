import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseWav } from '../util.js';
import { throwIfAborted, type EngineInfo, type EngineVoice, type SynthesisRequest, type TtsEngine } from './types.js';

const execFileAsync = promisify(execFile);

/** darwin `say`：`-r` 单位是每分钟词数，基准 175。 */
const BASE_WPM = 175;

interface SayVoiceLine {
  name: string;
  lang: string;
  comment: string;
}

function parseSayVoiceList(stdout: string): SayVoiceLine[] {
  const voices: SayVoiceLine[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // 格式：Name                          lang  # comment
    const match = line.match(/^(.+?)\s{2,}([a-zA-Z_-]{2,10})\s+#\s*(.*)$/);
    if (match) voices.push({ name: match[1].trim(), lang: match[2], comment: match[3].trim() });
  }
  return voices;
}

function buildArgs(request: SynthesisRequest, outPath: string, textFile: string): string[] {
  const speed = request.speed || 1;
  return [
    '-v', request.voice.name.replace(/^say:/, ''),
    '-r', String(Math.max(80, Math.round(BASE_WPM * speed))),
    '--data-format=LEI16@22050',
    '-f', textFile,
    '-o', outPath,
  ];
}

export class SayEngine implements TtsEngine {
  readonly info: EngineInfo = {
    id: 'say',
    displayName: 'macOS 系统音色',
    kind: 'system',
    supportsPitch: false,
    available: false,
  };
  private voicesCache: EngineVoice[] | null = null;

  async listVoices(): Promise<EngineVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    try {
      const { stdout } = await execFileAsync('say', ['-v', '?'], { timeout: 15000, maxBuffer: 1024 * 1024 });
      this.voicesCache = parseSayVoiceList(stdout).map(item => ({
        id: `say:${item.name}`,
        engineId: 'say',
        name: item.name,
        lang: item.lang,
        gender: /female|女/i.test(item.comment) ? 'female' : /male|男/i.test(item.comment) ? 'male' : 'unknown',
        tags: ['系统内置', item.lang.startsWith('zh') ? '中文' : item.lang.startsWith('en') ? '英语' : '其他'],
      }));
      this.info.available = this.voicesCache.length > 0;
      if (!this.info.available) this.info.reason = 'say 没有列出可用音色';
    } catch (error) {
      this.info.available = false;
      this.info.reason = `say 不可用：${String((error as NodeJS.ErrnoException).code ?? (error as Error).message).slice(0, 80)}`;
      this.voicesCache = [];
    }
    return this.voicesCache;
  }

  async synthesize(request: SynthesisRequest): Promise<{ durationMs: number }> {
    const voices = await this.listVoices();
    if (!voices.some(voice => voice.id === request.voice.id)) throw new Error(`音色不存在：${request.voice.name}`);
    throwIfAborted(request.signal);
    const textFile = `${request.outFile}.txt`;
    const { writeFile, rm } = await import('node:fs/promises');
    await writeFile(textFile, request.text, 'utf8');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('say', buildArgs(request, request.outFile, textFile), { stdio: 'ignore' });
        const onAbort = () => child.kill();
        request.signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', reject);
        child.on('close', code => {
          request.signal.removeEventListener('abort', onAbort);
          if (request.signal.aborted) return reject(new Error('操作已取消'));
          if (code === 0) return resolve();
          reject(new Error(`say 退出码 ${code}`));
        });
      });
      const wav = await (await import('node:fs/promises')).readFile(request.outFile);
      return { durationMs: parseWav(wav).durationMs };
    } finally {
      await rm(textFile, { force: true });
    }
  }

  dispose(): void {
    this.voicesCache = null;
  }
}
