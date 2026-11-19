/** sherpa-onnx-node 是可选依赖且未自带 d.ts，这里声明后台用到的最小 API 面。 */
declare module 'sherpa-onnx-node' {
  export interface SherpaGeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface SherpaTtsProgress {
    samples: Float32Array;
    progress: number;
  }

  export class OfflineTts {
    sampleRate: number;
    numSpeakers: number;
    lang: string;
    constructor(config: Record<string, unknown>);
    generate(request: { text: string; sid: number; speed: number }): SherpaGeneratedAudio;
    generateAsync(request: {
      text: string;
      sid: number;
      speed: number;
      onProgress?: (info: SherpaTtsProgress) => number | boolean | void;
    }): Promise<SherpaGeneratedAudio>;
  }
}

/** unbzip2-stream 未自带类型：返回一个把 bzip2 流解压为原始字节的 Transform。 */
declare module 'unbzip2-stream' {
  import type { Transform } from 'node:stream';
  function bunzip2(): Transform;
  export default bunzip2;
}
