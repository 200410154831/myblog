/**
 * 从 HTML import 生成 os-process-fundation（配图 + index.md）
 * 运行：node scripts/import-os-process.mjs
 */
import fs from "fs";
import path from "path";

const root = process.cwd();
const srcMd = path.join(
  root,
  "content/zh/blog/HTML import/进程（Process）.md",
);
const srcAtt = path.join(
  root,
  "content/zh/blog/HTML import/Attachments",
);
const outDir = path.join(root, "content/zh/blog/os-process-fundation");

const fileToFig = [
  "Untitled (3).png",
  "Untitled (2).png",
  "Untitled (1).png",
  "Untitled (4).png",
  "Untitled.png",
  "Untitled (8).png",
  "Untitled (9).png",
  "Untitled (7).png",
  "Untitled (6).png",
  "Untitled (5).png",
  "Untitled (12).png",
  "Untitled (13).png",
  "Untitled (10).png",
  "Untitled (11).png",
  "Untitled (14).png",
  "Untitled (15).png",
  "Untitled (17).png",
  "Untitled (16).png",
  "Untitled (19).png",
  "Untitled (18).png",
];

function tailToFilename(tail) {
  let s = tail
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/%20/g, " ");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }
  return s;
}

if (!fs.existsSync(srcMd)) {
  console.error("Missing:", srcMd);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fileToFig.forEach((fname, i) => {
  const out = `fig-${String(i + 1).padStart(2, "0")}.png`;
  fs.copyFileSync(path.join(srcAtt, fname), path.join(outDir, out));
});

let t = fs.readFileSync(srcMd, "utf8");

t = t.replace(/^\s*#\s*\*\*进程（Process）\*\*\s*\n*/m, "");

if (!t.includes("## 导读")) {
  t = t.replace(/^(\s*)(通俗地说)/m, "$1## 导读\n\n$1$2");
}

const imgRx = /!\[\]\(HTML%20import\/Attachments\/(.+?\.png)\)/g;
t = t.replace(imgRx, (full, tail) => {
  const fname = tailToFilename(tail);
  const idx = fileToFig.indexOf(fname);
  if (idx < 0) {
    console.warn("Unknown image file:", fname, full);
    return full;
  }
  const fig = `fig-${String(idx + 1).padStart(2, "0")}.png`;
  return `![插图 ${idx + 1}](${fig})`;
});

t = t.replace(
  /!\[插图 (\d+)\]\((fig-\d+\.png)\)!\[插图 (\d+)\]\((fig-\d+\.png)\)!\[插图 (\d+)\]\((fig-\d+\.png)\)/g,
  '<figure class="process-figure-row">\n\n![插图 $1]($2)\n\n![插图 $3]($4)\n\n![插图 $5]($6)\n\n</figure>',
);

t = t.replace(
  /!\[插图 (\d+)\]\((fig-\d+\.png)\)!\[插图 (\d+)\]\((fig-\d+\.png)\)/g,
  '<figure class="process-figure-row">\n\n![插图 $1]($2)\n\n![插图 $3]($4)\n\n</figure>',
);

for (const line of [
  "# 程序 vs. 进程",
  "# 进程操作",
  "# 真实的进程操作运行机制",
  "# 内核空间和用户空间的隔离机制",
]) {
  t = t.replace(new RegExp("^" + line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "m"), "## " + line.slice(2));
}

t = t.replace(/\|   \|   \|   \|\r?\n\|---\|---\|---\|\r?\n\|/g, "|");
t = t.replace(/\|   \|   \|\r?\n\|---\|---\|\r?\n\|/g, "|");

t = t.replace(/\|(\*\*[^|]+\*\*)\|(\*\*[^|]+\*\*)\|(\*\*[^|]+\*\*)\|/g, "| $1 | $2 | $3 |");
t = t.replace(/\|(\*\*[^|]+\*\*)\|(\*\*[^|]+\*\*)\|(?!\|)/gm, "| $1 | $2 |");

t = t.replace(/\|(\*\*[^|]+\*\*)\|(\*\*[^|]+\*\*)\|(\*\*[^|]+\*\*)\|(\s*)\n\| --- \| --- \| --- \|(\s*)\n\| --- \| --- \| --- \|/g, "| $1 | $2 | $3 |$4\n| --- | --- | --- |$5\n");

t = t.replace(
  /(\| \*\*代码类型\*\*[^|]+\|[^|]+\|[^|]+\|)\n(\| --- \| --- \| --- \|)\n(\| --- \| --- \| --- \|)/g,
  "$1\n$2",
);

{
  const hdr = "| **特性** | **fork()** | **exec()** |";
  let from = 0;
  while ((from = t.indexOf(hdr, from)) !== -1) {
    const afterHdr = from + hdr.length;
    const nl = t.indexOf("\n", afterHdr);
    const secondLineStart = nl === -1 ? -1 : nl + 1;
    const secondNl =
      secondLineStart === -1 ? -1 : t.indexOf("\n", secondLineStart);
    const secondLine =
      secondLineStart === -1
        ? ""
        : t.slice(
            secondLineStart,
            secondNl === -1 ? undefined : secondNl,
          ).trim();
    const hasSeparator = /^\|(?:\s*---\s*\|){3}\s*$/.test(secondLine);
    if (secondLine && !hasSeparator) {
      t = t.slice(0, afterHdr) + "\n| --- | --- | --- |" + t.slice(afterHdr);
      from = afterHdr + 25;
    } else {
      from = afterHdr + 1;
    }
  }
}

t = t.split("- **处理宏定义 (**`**#define**`**)**：").join("- **处理宏定义（`#define`）**：");
t = t.split("- **包含头文件 (**`**#include**`**)**：").join("- **包含头文件（`#include`）**：");

t = t.replace(/^\s+$/gm, "");
t = t.replace(/\n{4,}/g, "\n\n\n");
t = t.replace(/[ \t]+$/gm, "");

const fixes = [
  [
    "当一个可执行文件从磁盘加载到内存中时，它就从一个静态的“程序”变成了一个活跃的“进程",
    "当一个可执行文件从磁盘加载到内存中时，它就从一个静态的“程序”变成一个活跃的「进程」。",
  ],
  [
    "因为它拥有一个**程序计数器（Program Counter）来指向下一条要执行的指令，并伴随有一系列相关的**系统资源。",
    "因为它拥有**程序计数器（Program Counter）**来指向下一条要执行的指令，并伴随有一系列**相关的系统资源**。",
  ],
  [
    "虽然它们的**代码段（Text section）可能相同，但它们的**数据段（Data）、堆（Heap）**和**栈（Stack）**空间是完全独立的，互不干扰。",
    "虽然它们的**代码段（Text section）**可能相同，但它们的**数据段（Data）**、**堆（Heap）**与**栈（Stack）**空间是完全独立的，互不干扰。",
  ],
  [
    "我们实际上是通过**系统调用（System Call）触发了特殊的硬件指令（如** `**syscall**` **或陷阱中断），将 CPU 的执行权限交给了操作系统的**内核（Kernel）。",
    "我们实际上是通过**系统调用（System Call）**触发了特殊的硬件指令（如 **`syscall`** 或陷阱中断），将 CPU 的执行权限交给操作系统的**内核（Kernel）**。",
  ],
  ["2**. 用户空间", "2. **用户空间"],
  ["3**. 已打开文件", "3. **已打开文件"],
];
for (const [a, b] of fixes) t = t.split(a).join(b);

const keepH2 = new Set([
  "## 导读",
  "## 程序 vs. 进程",
  "## 进程操作",
  "## 真实的进程操作运行机制",
  "## 内核空间和用户空间的隔离机制",
]);
const demoteHeadings = (text) => {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (trimmed.startsWith("## ") && !keepH2.has(trimmed)) {
        return "### " + line.replace(/^## /, "");
      }
      return line;
    })
    .join("\n");
};
t = demoteHeadings(t);

t = t.replace(
  /^### (第一阶段|第二阶段|第三阶段|第四阶段|为什么不直接一步到位)/gm,
  "#### $1",
);

const front = `---
title: "操作系统进程基础：从程序构建到 fork、exec 与 wait"
meta_title: ""
description: "导读进程与程序、编译链接、ELF 与内存布局、进程状态与 PCB，以及 fork/exec/wait、用户态与内核态、系统调用在底层如何工作。"
date: 2026-05-07T12:00:00+08:00
image: "cover.png"
categories: ["笔记", "操作系统"]
author: "作者甲"
tags: ["进程", "Linux", "操作系统", "系统调用"]
draft: false
longread: true
---

`;

fs.writeFileSync(path.join(outDir, "index.md"), front + t.trim() + "\n", "utf8");
console.log("OK:", path.relative(root, path.join(outDir, "index.md")));
