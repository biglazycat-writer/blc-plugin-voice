import { connect } from 'blc-plugin-sdk/browser';
import { waitForTask, type Json } from 'blc-plugin-sdk';
import './style.css';

type ViewState = { name: string; count: number };

const sdk = await connect();
const session = await sdk.context();

// 页面状态由宿主恢复，先校验类型再使用，不要假设它一定是自己的结构。
const restored = session.state;
const initial: ViewState = { name: '大懒猫', count: 0 };
if (restored && typeof restored === 'object' && !Array.isArray(restored)) {
  const record = restored as Record<string, Json>;
  if (typeof record.name === 'string') initial.name = record.name;
  if (typeof record.count === 'number' && Number.isFinite(record.count)) initial.count = record.count;
}

let name = initial.name;
let count = initial.count;
let dirty = false;

/** 命令返回的是宿主任务，需要轮询任务状态才能拿到结果。 */
async function invoke<T>(command: string, args: Json = {}): Promise<T> {
  const task = await sdk.commands.invoke(command, args);
  return (await waitForTask(sdk.tasks, task.id)).result as unknown as T;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const root = document.getElementById('app')!;
root.replaceChildren();

const title = element('h1', '插件模板 · Hello World');
const hint = element('p', '最小可运行示例：后台命令、浏览器视图、状态保存。改这里开始做你的插件。');
hint.className = 'hint';
const nameLabel = element('label', '名字');
const nameInput = element('input');
nameInput.type = 'text';
nameInput.value = name;
nameLabel.append(nameInput);
const row = element('div');
row.className = 'row';
const helloButton = element('button', '调用 template.hello');
const counterButton = element('button', '点击 +1');
row.append(helloButton, counterButton);
const result = element('p');
result.className = 'result';
const status = element('p');
status.className = 'status';
root.append(title, hint, nameLabel, row, result, status);

function snapshot(): Json {
  return { name, count };
}
function renderStatus() {
  status.textContent = dirty ? '有未保存的修改…' : `状态已保存 · 计数 ${count}`;
}
function markDirty() {
  dirty = true;
  void sdk.setState(snapshot(), true).catch(error => {
    result.textContent = `状态保存失败：${String(error)}`;
  });
  renderStatus();
}

// 宿主在保存时调用：把状态完整写回并清除 dirty。失败要抛出，让宿主保持未保存状态。
sdk.onSave(async () => {
  await sdk.setState(snapshot(), false);
  dirty = false;
  renderStatus();
});

nameInput.addEventListener('input', () => {
  name = nameInput.value;
  markDirty();
});
counterButton.addEventListener('click', () => {
  count += 1;
  markDirty();
});
helloButton.addEventListener('click', () => {
  void (async () => {
    helloButton.disabled = true;
    result.textContent = '正在执行…';
    try {
      const reply = await invoke<{ message: string; from: string }>('template.hello', { name });
      result.textContent = `${reply.message}（来自 ${reply.from}）`;
    } catch (error) {
      result.textContent = `调用失败：${String((error as Error).message ?? error)}`;
    } finally {
      helloButton.disabled = false;
    }
  })();
});

renderStatus();
