// 生成 policy 锚点快照：src/router/design-headings.json
//
// 为什么要有快照：规则表的 policyRef 指向 R1-DESIGN.md 的真实标题（§4.3/§5.2/§5.3/§5.4/§5.5）。
// 设计文档在仓库外（由参数或 $R1_DESIGN_DOC 指定，默认不写死本机路径），VM 上没有这份文件；
// 快照让"锚点可解析"在离线环境里也能被验证，而不是 0 命中还继续跑。
//
// 用法：
//   node src/router/gen-design-headings.mjs <设计文档路径> [--out 快照路径]
// 默认：$R1_DESIGN_DOC → src/router/design-headings.json（两者都没给时报用法错误，exit 2）

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC = process.env.R1_DESIGN_DOC || '';
const DEFAULT_OUT = path.join(HERE, 'design-headings.json');

// 规则表实际引用的节；只快照这些节的正文，够 judge 核对 policyQuote，又不复制整份设计。
// J8（2026-11-03）起新增 §5.8：六条裁决的规则（R-ID-CONSENT / R-MEM-LOCAL / R-MEM-DISTILL / R-SES-ASK）都锚在这里。
const SECTIONS = ['4.3', '5.2', '5.3', '5.4', '5.5', '5.8'];

function parseHeadings(text) {
  const headings = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (!match) continue;
    headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 });
  }
  return headings;
}

// 快照随包发布：正文里的本机路径必须清洗，否则 PORT5 会把"引用原文"当成泄漏。
// sourceSha256 / sourceBytes 仍按原文计算，用来证明快照确实来自那份设计文档。
const REDACTIONS = [
  [new RegExp('[A-Za-z]:[\\\\/]+[^\\\\/\\s`]+[\\\\/]+research[\\\\/]+longlive-051', 'gi'), '<research-root>'],
  [new RegExp('[A-Za-z]:[\\\\/]+dsh-memory', 'gi'), '<memory-root>'],
  [new RegExp('[A-Za-z]:[\\\\/]+Users[\\\\/]+[^\\\\/\\s`]+', 'gi'), '<home>'],
];

function redact(text) {
  return REDACTIONS.reduce((out, [re, placeholder]) => out.replace(re, placeholder), text);
}

// 快照里的 source 只做定位提示：能写成仓库内相对路径就写相对路径，仓库外只留文件名。
function portableSource(docFile) {
  const rel = path.relative(process.cwd(), docFile);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return path.basename(docFile);
}

function sectionBody(lines, heading) {
  const body = [];
  for (const line of lines.slice(heading.line)) {
    const next = /^(#{1,6})\s+/.exec(line);
    if (next && next[1].length <= heading.level) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function main() {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const outFile = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : DEFAULT_OUT;
  const positional = argv.filter((arg, index) => !arg.startsWith('--') && (outIndex < 0 || index !== outIndex + 1));
  if (!positional[0] && !DEFAULT_DOC) {
    process.stderr.write('用法：node src/router/gen-design-headings.mjs <设计文档路径> [--out 快照路径]（或设 $R1_DESIGN_DOC）\n');
    process.exitCode = 2;
    return;
  }
  const docFile = path.resolve(positional[0] || DEFAULT_DOC);

  const text = fs.readFileSync(docFile, 'utf8');
  const lines = text.split('\n');
  const headings = parseHeadings(text);
  const sections = {};
  for (const section of SECTIONS) {
    const heading = headings.find((item) => item.text.startsWith(`${section} `) || item.text.startsWith(`${section}.`));
    if (!heading) {
      process.stderr.write(`设计文档里没有 §${section}\n`);
      process.exitCode = 1;
      return;
    }
    sections[section] = {
      title: heading.text.slice(section.length).trim(),
      level: heading.level,
      body: redact(sectionBody(lines, heading)),
    };
  }

  const snapshot = {
    doc: path.basename(docFile),
    source: portableSource(docFile),
    sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    sourceBytes: Buffer.byteLength(text),
    generatedBy: 'src/router/gen-design-headings.mjs',
    headings: headings.map(({ level, text: title, line }) => ({ level, text: title, line })),
    sections,
  };
  fs.writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`wrote ${outFile} (${headings.length} headings, ${Object.keys(sections).length} sections)\n`);
}

main();
