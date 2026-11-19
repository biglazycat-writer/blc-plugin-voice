/** 从 AI 输出中提取第一个 JSON 数组（容忍 markdown 代码块与前后缀话术）。 */
export function extractJsonArray(text: string): unknown[] | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const bracket = text.indexOf('[');
  if (bracket >= 0) {
    // 取最外层配对方括号
    let depth = 0;
    for (let i = bracket; i < text.length; i += 1) {
      if (text[i] === '[') depth += 1;
      else if (text[i] === ']') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(bracket, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim().replace(/,\s*([}\]])/g, '$1'));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}
