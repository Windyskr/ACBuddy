import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 向量检索的对照实验：用 bge-small-zh-v1.5 的量化模型（24 MB，和端上要用的是同一个文件）算好向量存下来。
// 依赖很大，单独装：cd eval/embed && npm install --ignore-scripts
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(ROOT, '..', '.cache');
const FILE = path.join(CACHE_DIR, 'embeddings-bge-small-zh.json');
const MODEL = 'Xenova/bge-small-zh-v1.5';
/** bge 建议短查询加这句前缀，记忆内容不加 */
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

export type Embeddings = Map<string, number[]>;

export function loadEmbeddings(): Embeddings | null {
  if (!existsSync(FILE)) return null;
  return new Map(Object.entries(JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, number[]>));
}

export async function buildEmbeddings(texts: string[]) {
  const { pipeline, env } = await import(path.join(ROOT, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')) as {
    pipeline(task: string, model: string, options: object): Promise<(input: string[], options: object) => Promise<{ tolist(): number[][] }>>;
    env: { cacheDir: string };
  };
  env.cacheDir = path.join(CACHE_DIR, 'hf');
  const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  const known = loadEmbeddings() ?? new Map<string, number[]>();
  const missing = [...new Set(texts)].filter((text) => !known.has(text));
  const started = performance.now();
  for (let index = 0; index < missing.length; index += 16) {
    const batch = missing.slice(index, index + 16);
    const vectors = (await embed(batch, { pooling: 'mean', normalize: true })).tolist();
    batch.forEach((text, position) => known.set(text, vectors[position]!.map((value) => Number(value.toFixed(5)))));
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(Object.fromEntries(known)));
  return { total: known.size, added: missing.length, msPerText: missing.length ? (performance.now() - started) / missing.length : 0 };
}

export const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
