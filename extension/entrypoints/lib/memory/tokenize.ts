const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
// 分词器会把 C++、C# 切成 c，这里先认出来；其余符号都当分隔
const SPECIAL = /c\+\+|c#|f#/g;
// 只滤最常见的虚词和代词。题目领域的词（比如「题」「解法」）留给 IDF 去压
const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '和', '与', '及', '或', '也', '就', '都', '而', '这', '那',
  '吗', '呢', '吧', '啊', '呀', '要', '会', '能', '有', '没', '不', '很', '还', '一', '个', '着', '过', '把', '被',
  '我的', '你的', '我们', '你们', '什么', '怎么', '怎样', '如何', '为什么', '哪些', '哪个', '多少', '是不是', '这个', '那个', '一下', '一个',
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'for', 'on', 'at', 'it',
  'this', 'that', 'i', 'you', 'my', 'me', 'do', 'did', 'does', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
]);

export interface TokenizeOptions {
  /** 连续汉字再切字二元组：分词器切分不稳定（「滑动窗口」切成 滑/动/窗口）时仍能匹配 */
  bigrams?: boolean;
}

export function tokenize(text: string, { bigrams = true }: TokenizeOptions = {}): string[] {
  const tokens: string[] = [];
  const normalized = text.normalize('NFKC').toLowerCase().replace(SPECIAL, (name) => {
    tokens.push(name);
    return ' ';
  });
  for (const { segment, isWordLike } of segmenter.segment(normalized)) {
    if (isWordLike && !STOPWORDS.has(segment)) tokens.push(segment);
  }
  if (bigrams) {
    // 已经是词的不重复算，否则「二分」的词频会翻倍
    const words = new Set(tokens);
    for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
      for (let i = 0; i + 2 <= run.length; i++) {
        const bigram = run.slice(i, i + 2);
        if (!words.has(bigram) && !STOPWORDS.has(bigram)) tokens.push(bigram);
      }
    }
  }
  return tokens;
}
