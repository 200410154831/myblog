/**
 * 一次性迁移脚本：原数据目录 `content/zh/blog/HTML import` 已删除。
 * 若再次从 Obsidian 导入，请把源 md 路径改回下面 `src` 再运行。
 */
import fs from "fs";
import path from "path";

const src = path.join(
  "content/zh/blog/HTML import",
  "进程（Process）.md",
);
const out = path.join("content/zh/blog/os-process-fundation", "index.md");

let t = fs.readFileSync(src, "utf8");

// 必须按「更长/更具体的字符串优先」顺序替换
const reps = [
  ["![](HTML%20import/Attachments/image%20[15].png)", "![图示](fig-16.png)"],
  ["![](HTML%20import/Attachments/image%20[14].png)", "![图示](fig-15.png)"],
  ["![](HTML%20import/Attachments/image%20[13].png)", "![图示](fig-14.png)"],
  ["![](HTML%20import/Attachments/image%20[12].png)", "![图示](fig-13.png)"],
  ["![](HTML%20import/Attachments/image%20[11].png)", "![图示](fig-12.png)"],
  ["![](HTML%20import/Attachments/image%20[10].png)", "![图示](fig-11.png)"],
  ["![](HTML%20import/Attachments/image%20[9].png)", "![图示](fig-10.png)"],
  ["![](HTML%20import/Attachments/image%20[8].png)", "![图示](fig-09.png)"],
  ["![](HTML%20import/Attachments/image%20[7].png)", "![图示](fig-08.png)"],
  ["![](HTML%20import/Attachments/image%20[6].png)", "![图示](fig-07.png)"],
  ["![](HTML%20import/Attachments/image%20[5].png)", "![图示](fig-06.png)"],
  ["![](HTML%20import/Attachments/image%20[4].png)", "![图示](fig-05.png)"],
  ["![](HTML%20import/Attachments/image%20[3].png)", "![图示](fig-04.png)"],
  ["![](HTML%20import/Attachments/image%20[2].png)", "![图示](fig-03.png)"],
  ["![](HTML%20import/Attachments/image%20[1].png)", "![图示](fig-02.png)"],
  ["![](HTML%20import/Attachments/Image%20[3]%201.png)", "![图示](fig-20.png)"],
  ["![](HTML%20import/Attachments/Image%20[2]%201.png)", "![图示](fig-19.png)"],
  ["![](HTML%20import/Attachments/Image%20[1]%201.png)", "![图示](fig-18.png)"],
  ["![](HTML%20import/Attachments/Image%201.png)", "![图示](fig-17.png)"],
  ["![](HTML%20import/Attachments/image.png)", "![图示](fig-01.png)"],
];

for (const [o, n] of reps) {
  t = t.split(o).join(n);
}

// 同一行紧挨的两张图 → 分行
t = t.replace(/!\[图示\]\((fig-\d+\.png)\)!\[图示\]\((fig-\d+\.png)\)/g, "![图示]($1)\n\n![图示]($2)");

// 嵌入式 SVG 占位
t = t.replace(
  /!\[\]\(data:image\/svg\+xml[^)]+\)/g,
  "> **CPU 时间（概念公式）**：总耗时 ≈ **用户时间（User Time）** + **系统时间（System Time）**。",
);

t = t.replace(/[ \t]+$/gm, "");
t = t.replace(/^\s+/, "");
t = t.replace(/\n{4,}/g, "\n\n\n");

const fixes = [
  ["变成一个活跃的\"进程", "变成一个活跃的「进程」。"],
  [
    "因为它拥有一个**程序计数器（Program Counter）来指向下一条要执行的指令，并伴随有一系列相关的**系统资源。",
    "因为它拥有**程序计数器（Program Counter）**来指向下一条要执行的指令，并伴随有一系列**相关的系统资源**。",
  ],
  [
    "虽然它们的**代码段（Text section）可能相同，但它们的**数据段（Data）、堆（Heap）**和**栈（Stack）**空间是完全独立的，互不干扰。",
    "虽然它们的**代码段（Text section）**可能相同，但它们的**数据段（Data）**、**堆（Heap）**和**栈（Stack）**空间是完全独立的，互不干扰。",
  ],
  [
    "通过 `image_0c56c2.png` 中的代码示例",
    "通过示意图中的代码示例",
  ],
  ["2**. 用户空间", "2. **用户空间"],
  ["3**. 已打开文件", "3. **已打开文件"],
];
for (const [a, b] of fixes) {
  t = t.split(a).join(b);
}

const front = `---
title: "操作系统中的进程：从程序到 PCB 与系统调用"
meta_title: ""
description: "通俗理解进程与程序的区别、编译链接、ELF、内存布局、进程状态，以及 fork / exec / wait 与内核态、用户态。"
date: 2026-05-07T12:00:00+08:00
image: "fig-01.png"
categories: ["笔记", "操作系统"]
author: "作者甲"
tags: ["进程", "Linux", "操作系统", "系统调用"]
draft: false
---

`;

fs.writeFileSync(out, front + t.trimEnd() + "\n", "utf8");
console.log("Wrote", out);
