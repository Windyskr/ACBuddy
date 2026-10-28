/** 内容统一先 HTML 转义再生成标签，输出不含任何用户可控 HTML（防存储型 XSS） */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(s: string): string {
  let out = escapeHtml(s);
  // 链接仅允许 http(s)，href 里的引号已转义为 &quot;，无法逃出属性
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inCode = false;
  let codeBuf: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const closePara = () => {
    if (para.length) {
      html.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote.length) {
      html.push(`<blockquote><p>${quote.join("<br>")}</p></blockquote>`);
      quote = [];
    }
  };
  const closeAll = () => {
    closePara();
    closeList();
    closeQuote();
  };

  for (const raw of lines) {
    const t = raw.trim();

    if (inCode) {
      if (/^```/.test(t)) {
        html.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        codeBuf.push(raw);
      }
      continue;
    }

    if (/^```/.test(t)) {
      closeAll();
      inCode = true;
      continue;
    }
    if (!t) {
      closeAll();
      continue;
    }

    const heading = t.match(/^(#{1,3})\s+(.*)/);
    if (heading) {
      closeAll();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(t)) {
      closePara();
      closeList();
      quote.push(inline(t.replace(/^>\s?/, "")));
      continue;
    }
    const ul = t.match(/^[-*]\s+(.*)/);
    if (ul) {
      closePara();
      closeQuote();
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = t.match(/^\d+[.)]\s+(.*)/);
    if (ol) {
      closePara();
      closeQuote();
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    closeQuote();
    para.push(inline(t));
  }

  if (inCode) html.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  closeAll();
  return html.join("");
}
