---
title: "排版与组件示例"
meta_title: ""
description: "Markdown 与短代码常用写法示例，可拷贝到你的文章里。"
draft: false
---

{{< toc >}}

下面是标题与排版示例。Markdown 中用 `#` 表示一级标题，`######` 表示六级标题。

# 一级标题

## 二级标题

### 三级标题

#### 四级标题

##### 五级标题

###### 六级标题

---

### 强调

斜体可用 *星号* 或 _下划线_。

加粗用 **星号** 或 __下划线__。

**组合：加粗里嵌 _斜体_**。

删除线用双波浪线：~~划掉这段~~。

---

### 按钮

{{< button label="按钮" link="/" style="solid" >}}

---

### 链接

[内联样式链接](https://www.google.com)

[带标题的内联链接](https://www.google.com "Google 首页")

[相对路径示例](/blog/)


尖括号内的网址会被自动转为链接。
<http://www.example.com> 或 <http://www.example.com>
下面可演示引用式链接等写法。

---

### 段落

这是一段示例正文，用来观察段落与行距效果。写博客时替换为你的中文内容即可。

---

### 有序列表

1. 列表项
2. 列表项
3. 列表项
4. 列表项
5. 列表项

---

### 无序列表

- 列表项
- 列表项
- 列表项
- 列表项
- 列表项

---

### 提示块

{{< notice "note" >}}
这是一条 note 提示。
{{< /notice >}}

{{< notice "quote" >}}
这是一条 quote 引用块。
{{< /notice >}}

{{< notice "tip" >}}
这是一条 tip 提示。
{{< /notice >}}

{{< notice "info" >}}
这是一条 info 信息。
{{< /notice >}}

{{< notice "warning" >}}
这是一条 warning 警告。
{{< /notice >}}

---

### 标签页

{{< tabs >}}
{{< tab "标签一" >}}

#### 标签页里的标题

标签页中的正文区域，可写任意 Markdown。

{{< /tab >}}

{{< tab "标签二" >}}

#### 第二个标签

同样可以放置正文与组件。

{{< /tab >}}

{{< tab "标签三" >}}

#### 第三个标签

用于演示多个标签页的切换效果。

{{< /tab >}}
{{< /tabs >}}

---

### 手风琴

{{< accordion "为什么需要手风琴组件？" >}}

- 可折叠内容，节省版面
- 适合 FAQ 或补充说明
- 与正文风格一致即可

{{< /accordion >}}

{{< accordion "如何让内容在水平方向居中？" >}}

- 优先用 Flex / Grid 布局
- 避免过多负边距造成错位
- 具体代码视你的主题而定

{{< /accordion >}}

{{< accordion "是否应该使用负外边距？" >}}

- 仅在明确知道布局后果时使用
- 可能影响可访问性与响应式表现
- 优先考虑内边距与间距工具类

{{< /accordion >}}

---

### 代码与高亮

这是一段行内代码示例：`const x = 1`。

```javascript
var s = "JavaScript syntax highlighting";
alert(s);
```

```python
s = "Python syntax highlighting"
print s
```

```c  { linenos=true }
#include <stdio.h>

int main(void)
{
    printf("hello, world\n");
    return 0;
}
```

```mermaid
flowchart TD
    A[Start] --> B{Is it?}
    B -- Yes --> C[OK]
    C --> D[Rethink]
    D --> B
    B -- No ----> E[End]
```

---

### 引用

> 这是一段引用示例。可把书摘、对话或需要强调的他人观点放在这里。

---

### 表格

| 表格示例   |    对齐方式   | 数值 |
| ---------- | :-----------: | ---: |
| 第三列示例 |    右对齐     | 1600 |
| 第二列示例 |    居中       |   12 |
| 斑马纹示例 |    左对齐习惯 |    1 |

---

### 图片

{{< image src="images/image-placeholder.png" caption="" alt="alter-text" height="" width="" position="center" command="fill" option="q100" class="img-fluid" title="image title"  webp="false" >}}

---

### 图片画廊

{{< gallery dir="images/gallery" class="" height="400" width="400" webp="true" command="Fit" option="" zoomable="true" >}}

---

### 轮播图

{{< slider dir="images/gallery" class="max-w-[600px] ml-0" height="400" width="400" webp="true" command="Fit" option="" zoomable="true" >}}

---

### YouTube 视频

{{< youtube ResipmZmpDU >}}

---

### 自定义视频

{{< video src="https://www.w3schools.com/html/mov_bbb.mp4" width="100%" height="auto" autoplay="false" loop="false" muted="false" controls="true" class="rounded-lg" >}}
