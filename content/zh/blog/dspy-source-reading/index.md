---
title: "Agent系列：DSPy 源码阅读"
meta_title: ""
description: "分层阅读 DSPy 源码：门面与 settings、primitives 与数据、predict 推理主轴、teleprompt 优化与 evaluate，理解其作为 LLM Runtime System 的设计。"
date: 2026-05-09T12:00:00+08:00
image: cover.png
categories:
  - 笔记
  - Agent
  - DSPy
author: 作者
tags:
  - DSPy
  - 源码阅读
  - Python
  - LLM
draft: false
longread: true
---

## 第一层：门面与全局上下文

## `**__init__.py**`

看清对外暴露了哪些模块，避免之后在子目录里迷路。

这个代码是DSPy的整体架构图，本质可以压缩成：

```
dspy
├── 推理模块（predict）
├── 基础对象（primitives）
├── RAG检索（retrievers）
├── Signature系统（signatures）
├── Prompt优化器（teleprompt）
├── 模型客户端（clients）
├── Prompt适配器（adapters）
├── 评测（evaluate）
├── Runtime工具（stream/cache/async/settings）
└── 全局配置
```

阅读DSPy 子目录时先问：

```
1. 核心抽象？
2. Runtime？
3. 工程工具？
4. Provider实现？
```

DSPy 真正核心只有：

```
Signature
Predict
Teleprompt
Adapter
```

剩下很多都只是支撑层

除此之外还要注意这里给 DSPy 用户（框架使用者）指明了许多别名：

```python
# Singleton definitions and aliasing
configure = settings.configure
load_settings = settings.load
context = settings.context

BootstrapRS = BootstrapFewShotWithRandomSearch

cache = DSPY_CACHE
```

  

  

## `**dsp/utils/settings.py**`（全局配置）

`configure` / `context`、`lm`、`adapter`、`trace` 等会贯穿几乎所有调用，早一点读，`Predict` / `Adapter` 里出现的 `settings` 才对得上。

这份源码暴露了DSPy 最底层的全局运行时设计，它负责：

- 全局LM

- 线程隔离

- async隔离

- context覆盖

- trace

- callbacks

- usage tracking

- 并行配置

**本质上，DSPy不是“prompt库”，而是带运行时状态的LLM操作系统**

这份代码的真正核心只有四个

```python
DEFAULT_CONFIG
        ↓
main_thread_config（全局默认）
        ↓
thread_local_overrides（局部覆盖）
        ↓
Settings Singleton（统一访问入口）
```

其余代码都是围绕“全局配置如何安全运行”展开的

  

### DEFAULT_CONFIG

本质是DSPy Runtime 默认状态，是全局执行环境

```python
DEFAULT_CONFIG = dotdict(
    lm=None,
    adapter=None,
    rm=None,
    branch_idx=0,
    trace=[],
    callbacks=[],
    async_max_workers=8,
    send_stream=None,
    disable_history=False,
    track_usage=False,
    usage_tracker=None,
    caller_predict=None,
    caller_modules=None,
    stream_listeners=[],
    provide_traceback=False,  # Whether to include traceback information in error logs.
    num_threads=8,  # Number of threads to use for parallel processing.
    max_errors=10,  # Maximum errors before halting operations.
    # If true, async tools can be called in sync mode by getting converted to sync.
    allow_tool_async_sync_conversion=False,
    max_history_size=10000,
    max_trace_size=10000,
    warn_on_type_mismatch=True,  # Whether to log warnings when a module's input type doesn't match the signature type.
)
```

这些配置需求说明DSPy在把LLM程序“操作系统化”，而不是简单 prompt wrapper。

这里的 dotdict（）本质是 dict + attribute access ， 例如里面的 lm 参数是 config.lm ，而不是 config["lm"] , 这样方便 runtime 访问。

DSPy 认为 LLM 程序运行需要：

```
1. 模型环境
2. Prompt环境
3. Retriever环境
4. Execution Stack
5. Trace系统
6. Callback系统
7. Async Runtime
8. Tool Runtime
9. Streaming Runtime
10. 类型系统
```

DSPy 本质不是rompt engineering library，而是 LLM Runtime System，这些参数配置都是运行时注入，将逻辑和具体选择解耦

  

### main_thread_config

```python
main_thread_config = copy.deepcopy(DEFAULT_CONFIG)
```

DSPy 不是无状态prompt调用，而是有状态runtime

这里使用 deepcopy 是为了防止多个 runtime 共享同一个 list直接炸了。

  

### thread_local_overrides

```python
thread_local_overrides = contextvars.ContextVar("context_overrides", default=dotdict())
```

局部运行时覆盖层，方便运行时动态切换注入

  

### Settings Singleton

DSPy 认为 LLM Program 运行时需要一个统一环境

传统 Prompt Engineering 会这样写

```python
esponse = openai.chat(...)
```

所有配置都写死在调用里面。

DSPy 的思想是Module 不应该绑定具体LM，而应该从 Runtime 获取当前的配置

这样 DSPy Modules 依赖运行时上下文，而不是依赖硬编码参数。

```
当前有效配置  =  全局配置  +   局部override
```

为实现这样的思想，这里代码的核心设计思想是configure 和 context 分离

```python
dspy.configure(...) // 修改全局默认运行时
```

```python
with dspy.context(...): // 创建局部作用域
```

Setting类的其它方法也主要是为这一思想服务的，这里不做过多赘述

  

## 第二层：用户程序长相（组合 + 数据）

## `**primitives/（用户程序的基类）**`

`**Module**`（`forward` / `__call__`）、`**Prediction**`、`**Example**`：程序是什么、返回值是什么。

DSPy primitives 大致框架如下：

```
                 BaseModule
                      │
                  Module
                      │
        ┌─────────────┼─────────────┐
        │             │             │
    Predict      ChainOfThought   ReAct
        │
        ▼
    Prediction
        │
        ├── Completions
        └── Metadata

-----------------------------------

Example
   │
   ▼
Compiler / Optimizer

-----------------------------------

PythonInterpreter
CodeInterpreter
   │
   ▼
Tool Execution / Program-of-Thought
```

### `**__init__.py**`

DSPy 把很多最底层能力称为 primitives（原语），这些类是整个 DSPy 编程模型最核心的抽象。

然后通过：

```python
__all__ = [...]
```

统一暴露给用户。

于是用户就可以：

```python
import dspy

dspy.Module
dspy.Prediction
dspy.Example
```

而不用：

```python
from dspy.primitives.module import Module
```

### `**example.py**`

**数据集行 / trainset 里的单行容器**：字段访问、`with_inputs`、`inputs()` / `labels()` 等。**不依赖**本目录其它实现，是后面的基础。

代码里的注释如下，我们可以通过注释大致了解该类的作用

```python
"""
一个灵活的数据容器，用于表示 DSPy 中带命名字段（named fields）的样例（Example）与训练数据。

`Example` 大致可以理解为 HuggingFace 数据集或 pandas `DataFrame`
中的“一行数据”。它的行为很像字典（dictionary）或支持点访问（dot-access）
的记录对象：你既可以通过 `example["question"]`，也可以通过
`example.question` 来读取字段。

在 DSPy 中，由 `Example` 对象组成的列表就是你的：

- trainset（训练集）
- devset（验证集）
- testset（测试集）

大多数 Example 都是通过关键字参数（keyword arguments）
或者已有记录（record）创建的，然后再通过 `with_inputs(...)`
标记哪些字段应该作为模块输入（inputs）传入。

剩余字段则会被视为：

- labels（标签 / 期望输出）
- metadata（元数据）

当你编写：

- evaluation code（评估代码）
- custom optimizers（自定义优化器）
- training loops（训练循环）

时：

使用 `example.inputs()` 获取需要传入模块的输入字段；

使用 `example.labels()` 获取需要与模块输出进行比较的标签字段。

Examples:
    使用关键字参数构建 Example：

    >>> import dspy
    >>> example = dspy.Example(
    ...     question="法国的首都是什么？",
    ...     answer="巴黎",
    ... ).with_inputs("question")

    >>> example.question
    '法国的首都是什么？'

    >>> example.answer
    '巴黎'

    >>> example.inputs().toDict()
    {'question': '法国的首都是什么？'}

    --------------------------------------------------

    从已有记录创建 Example：

    >>> record = {"question": "2+2 等于多少？", "answer": "4"}

    >>> example = dspy.Example(**record).with_inputs("question")

    >>> example["question"]
    '2+2 等于多少？'

    >>> example.labels().answer
    '4'

    --------------------------------------------------

    指定哪些字段是输入：

    >>> example = dspy.Example(
    ...     question="今天天气怎么样？",
    ...     answer="天气晴朗",
    ... ).with_inputs("question")

    >>> example.inputs().question
    '今天天气怎么样？'

    >>> example.labels().answer
    '天气晴朗'

    --------------------------------------------------

    在训练集中使用 Example：

    >>> trainset = [
    ...     dspy.Example(question="2+2?", answer="4").with_inputs("question"),
    ...     dspy.Example(question="3+3?", answer="6").with_inputs("question"),
    ... ]

    >>> trainset[0].inputs().toDict()
    {'question': '2+2?'}

    --------------------------------------------------

    在指标函数（metric）中使用 Example：

    >>> def exact_match_metric(example, pred, trace=None):
    ...     return example.answer.lower() == pred.answer.lower()

    >>> gold = dspy.Example(
    ...     question="1+1?",
    ...     answer="2"
    ... ).with_inputs("question")

    >>> pred = dspy.Prediction(answer="2")

    >>> exact_match_metric(gold, pred)
    True

    --------------------------------------------------

    像字典一样使用：

    >>> example = dspy.Example(name="Alice", age=30).with_inputs("name")

    >>> "name" in example
    True

    >>> example.get("city", "Unknown")
    'Unknown'

See Also:
    [`dspy.Evaluate`]:
        用于在一组 `Example` 上评估 DSPy Program。

    [`Metrics`]:
        用于编写比较 `Example` 与 Prediction 的指标函数（metric）。
"""
```

从上面的描述中可以看出 DSPy 想让 Example 既像 dict，又像 object。

支持 example.question 和 example["question"]

下面对类内所有方法进行分类介绍：

#### 第一类：对象创建层

（1）init方法

```python
"""
根据字段（fields）或已有记录（existing record）创建一个 `Example` 对象。

在最常见的使用方式中，你可以直接通过关键字参数传入字段，例如：

    dspy.Example(question="...", answer="...")

当你已经有一个字典（dictionary）或者另一个 `Example`对象，并希望在复制其字段的基础上，再新增或覆盖部分字段时，
可以使用 `base` 参数。

Args:
    base:
        一个字典（dictionary）或 `Example` 对象。

        在应用 `**kwargs` 之前，会先从 `base`
        中复制字段。

        当 `base=None` 时，表示从空对象开始创建。

    **kwargs:
        要存储到 Example 中的字段名和值。

        如果某个字段同时出现在：

        - `base`
        - `**kwargs`

        中，则以 `**kwargs` 中的值为准（即 kwargs 会覆盖 base 中的值）。
"""
```

从上面注释中可知，example类可以由三种参数初始化：

- kwargs 创建

- dict 创建

- Example copy 创建

此外，阅读源码可以看到有三个类内数据结构，存储核心内部状态：

```python
# Internal storage and other attributes
self._store = {}
self._demos = []
self._input_keys = None
```

|成员|作用|本质|
|---|---|---|
|`_store`|存储所有字段数据|数据区|
|`_demos`|存储 few-shot demos|编译/优化区|
|`_input_keys`|标记哪些字段是输入|数据流定义|

具体实现距举例如下：

```python
ex = Example(
question = "2+2",
answer = "4"
).with_inputs("question")
```

内部：

```
Example
│
├── _store
│      ├── question → "2+2"
│      └── answer   → "4"
│
├── _input_keys
│      └── {"question"}
│
└── _demos
       └── []
```

  

（2）其他方法

def copy(self, **kwargs) 实现基于当前 Example 创建新 Example。

def without(self, *keys) 实现创建删除部分字段后的新 Example。

这两类方法实现很简单，不做过多介绍。

  

#### 第二类：字段访问层

（1）类似object的访问方法

def **getattr**(self, key) 和 def **setattr**(self, key, value)使得example可以像类一样访问和写数据字段。

```python
example.question
example.question = "..."
```

（2）类似dict的访问方法

def **getitem**(self, key) 和 def **setitem**(self, key, value)使得example可以像dict一样访问和写数据字段。

```python
example["question"]
example["x"] = 1
```

（3）删除字段和判断是否有某字段

def **delitem**(self, key) 和 def **contains**(self, key)，使得可以实现：

```python
"name" in example
```

  

#### 第三类：DSPy 数据流核心层

（1）def with_inputs(self, *keys)：定义哪些字段是 module 输入

```python
"""
标记哪些字段（fields）属于输入（inputs），并返回一个新的 `Example` 对象。

未在这里列出的字段会被视为：

- labels（标签）
- expected outputs（期望输出）

DSPy 的优化器（optimizers）和评估器（evaluators）
会利用这种“输入/标签”划分：

它们会：

- 将 `example.inputs()` 传入你的程序（program/module）
- 然后将程序输出与 `example.labels()` 进行比较

Args:
    *keys:
        输入字段（input fields）的名称。

Returns:
    返回当前 `Example` 的一个副本（copy），
    并在该副本中设置输入字段（input keys）。

Examples:
    >>> import dspy

    >>> ex = dspy.Example(
    ...     question="Why?",
    ...     answer="Because."
    ... ).with_inputs("question")

    >>> ex.inputs().keys()
    ['question']

    >>> ex.labels().keys()
    ['answer']
"""
```

（2）def inputs(self) 提取输入字段子集

```python
"""
返回一个新的 `Example` 对象，其中只包含输入字段（input fields）。

在调用该方法之前，必须先调用 `with_inputs(...)`
来指定哪些字段属于输入。

Raises:
    ValueError:
        如果当前 Example 尚未调用 `with_inputs(...)`
        设置输入字段，则会抛出该异常。

Examples:
    >>> import dspy

    >>> ex = dspy.Example(
    ...     question="Why?",
    ...     answer="Because."
    ... ).with_inputs("question")

    >>> ex.inputs()
    Example({'question': 'Why?'}) (input_keys={'question'})
"""
```

（3）def labels(self) 提取标签字段（非输入）

```python
"""
返回一个新的 `Example` 对象，其中只包含标签字段（label fields），
也就是：

非输入字段（non-input fields）。

由于 labels 被定义为：

“所有不属于输入（input）的字段”，

因此在调用该方法之前，必须先调用：

    with_inputs(...)

来指定哪些字段属于输入。

Examples:
    >>> import dspy

    >>> ex = dspy.Example(
    ...     question="Why?",
    ...     answer="Because."
    ... ).with_inputs("question")

    >>> ex.labels()
    Example({'answer': 'Because.'}) (input_keys=None)
"""
```

  

#### 第四类：字典兼容接口层

这类方法是为了兼容 Python dict 生态

```python
def keys(self, include_dspy=False)    
def values(self, include_dspy=False)
def items(self, include_dspy=False)
def get(self, key, default=None)
def __iter__(self)
```

它们本质只是 dict 包装

  

#### 第五类：对象行为层

这是 Python 对象协议。

```python
def __repr__(self) //调试显示
def __str__(self) //字符串显示
def __len__(self) //字段数量
def __eq__(self, other) //对象比较
def __hash__(self) //支持 set/dict key
```

  

#### 第六类：序列化层

def toDict(self) 实现递归序列化逻辑

  

  

### `**prediction.py**`

这份代码解决的是：

```
LLM 输出如何：
- 结构化
- 多候选化
- 可比较
- 可排序
- 可优化
```

你可以把它理解成：

```
Example = 训练/评测数据对象
Prediction = 推理输出对象
Completions = 多候选输出对象
```

**关键思想是：LLM的输出不是字符串，而是结构化运行时对象**

这使得 DSPy 可以：

- optimize

- rerank

- self-consistency

- reflection

- beam search

- reward modeling

- trace analysis

全部统一到Prediction Runtime System里。

#### Completion类

为什么 DSPy 要专门设计 Completions？

核心原因是现代 LLM一次往往不只生成一个答案，DSPy 不想丢掉这些候选，于是通过Completion来统一管理。

```python
{
   "answer": ["Paris", "Lyon"],
   "score": [0.9, 0.3]
}
```

```python

1. 初始化与数据规范化
────────────────────
__init__

作用：
- 接收多个 LLM completion
- 统一 completion 数据格式
- 将 list[dict] 转换为 field-oriented 结构
- 检查所有字段长度是否一致
- 建立内部 _completions 存储

核心实现：
- completion 标准化
- candidate alignment
- runtime storage initialization

解决的问题：
“多个 LLM 输出如何统一组织”


2. 数据访问系统
────────────────────
items
__getitem__
__getattr__

作用：
- 提供 completion 数据访问能力
- 支持字段访问
- 支持 candidate 访问
- 支持 attribute 风格访问

items：
- 返回 field → values 映射
- 用于遍历 completion 字段

__getitem__：
- completions[0]
    → 返回第 0 个 Prediction
- completions["answer"]
    → 返回 answer 字段所有 completion

核心实现：
- field-oriented ↔ sample-oriented 转换

__getattr__：
- 支持：
    completions.answer

解决的问题：
“如何方便访问 candidate space”


3. Python 容器协议
────────────────────
__len__
__contains__

作用：
- 让 Completions 像 Python 容器工作

__len__：
- 返回 completion 数量

__contains__：
- 支持：
    "answer" in completions

解决的问题：
“如何让 completion container 具备标准容器行为”


4. 调试与显示系统
────────────────────
__repr__
__str__

作用：
- 提供 completion 可视化输出
- 用于 debug / notebook / logging

__repr__：
- 格式化打印 completion 内容

__str__：
- 复用 __repr__

解决的问题：
“如何可读化显示 completion runtime object”


整个 Completions 类本质
────────────────────

Completions 本质是：

    LLM Candidate Runtime Container

它负责：

- 管理多个 completion
- 保存 candidate space
- 提供字段化访问
- 提供 candidate 级访问
- 支持 runtime optimization
- 支持 rerank / voting / self-consistency

最终实现：多候选 LLM 输出的运行时管理系统
```

  

#### prediction类

```python
"""
一个用于表示 DSPy 模块输出结果（output）的预测对象（Prediction object）。

Prediction 继承自 `Example`。

为了支持带反馈（feedback-augmented）的评分机制，
Prediction 对象在包含 `score` 字段时，
支持比较运算：    <   >   <=   >=

这些比较操作会将 score 字段转换为 float 后进行比较。

对于相等性比较（equality comparison）：

两个 Prediction 是否相等，
由其底层数据存储（underlying data store）是否相同决定，
这一行为继承自 `Example`。

此外，当 Prediction 含有 `score` 字段时，
还支持算术运算    +   /   等

这些运算都会基于score 值进行操作。
"""
```

```python
Prediction
├── 1. 生命周期/构造
├── 2. Runtime 元信息管理
├── 3. Completion 多候选系统
├── 4. 显示与调试
├── 5. Score 数值化系统
├── 6. 算术运算系统
├── 7. 比较运算系统
```

（1）生命周期 / 构造

```
def__init__(self,*args,**kwargs)
```

作用：

- 初始化 Prediction

- 继承 Example 的动态字段系统

- 删除训练语义字段

- 增加 runtime 字段

```
@classmethod
deffrom_completions(cls,list_or_dict,signature=None)
```

作用是从多个 completion构建 Prediction

核心：

```python
obj._store= {k:v[0] for k,v in obj._completions.items()}
```

这是Top-1 主输出选择机制

```
Top-1 主输出选择机制
```

  

（2）Runtime 元信息管理

```python
def get_lm_usage(self)
```

作用是获取：

- token usage

- cost

- latency

等运行时统计。

```python
def set_lm_usage(self,value)
```

作用是保存 runtime usage 信息。

  

（3）Completion 多候选系统

这些方法用于管理multiple candidate outputs

```python
@property
def completions(self)
```

作用是访问：

```python
self._completions
```

即全部候选输出

  

（4）显示 / 调试系统

def **repr**(self) def **str**(self) 打印 主 prediction 和 completion 状态

  

除了上面四类方法之外，还有一些和score计算相关的方法，不做过多赘述。

  

### `**base_module.py**`

DSPy 的 Program：

```python
cot = dspy.ChainOfThought(...)
rag = MyRAGModule(...)
agent = ReAct(...)
```

本质上都不是普通函数。

它们是可嵌套、可保存、可复制、可遍历 的 Program Object

因此 DSPy 必须解决：

- 如何管理参数？

- 如何递归遍历子模块？

- 如何复制整个 Program？

- 如何 reset 参数？

- 如何 checkpoint/save？

- 如何 restore/load？

代码符合逻辑的阅读顺序如下：

#### 第一层：模块管理

（1）init方法

```python
class BaseModule:
    def __init__(self):
        pass
```

这里什么都没做。

因为BaseModule 只是 Runtime Protocol Base Class

它主要提供：

- traversal logic

- state logic

- persistence logic

而不是具体业务状态

真正的状态由子类定义。

  

（2）named_sub_modules方法

```python
def named_sub_modules(self, type_=None, skip_compiled=False) -> Generator[tuple[str, "BaseModule"], None, None]
```

```python
"""
查找模块中的所有子模块，以及它们对应的名称。

例如：self.children[4]['key'].sub_module是一个子模块，

那么它对应的名称将会是children[4]['key'].sub_module

但是，如果同一个子模块可以通过不同路径访问到，那么只会返回其中一条路径。
"""
```

输入:

```python
named_sub_modules(type_=None)
```

输出:

```python
yield (name,module)
```

例如：

```python
[
 ("self",agent),
 ("self.planner",planner),
 ("self.retriever",retriever)
]
```

方法实现的原理本质是Module Graph BFS Traversal

  

（3）named_parameters方法

DSPy optimizer 需要找到所有可训练/可优化参数

例如：

- prompt

- demos

- LM config

- adapters

```python
def named_parameters(self)
```

同样也是遍历 + 去重

  

#### 第二层：对象复制机制

```python
deepcopy()
reset_copy()
```

#### 第三层：状态管理

```python
dump_state()
load_state()
```

这些是参数级 state_dict 机制

#### 第四层：持久化

```python
save()
load()
```

对 dump/load_state 的文件系统封装

  

### `**module.py**`

用户程序的 `**ProgramMeta**` **+** `**Module**`：`__call__`/`forward`、`caller_modules`、`history`、子模块编排。这里会依赖 `**settings**`**、**`**Prediction**`**、**`**Example**`**、**`**BaseModule**`，应放在上述文件之后。

`Module` 是 DSPy 里所有“程序 / Agent / Pipeline”的基础类。

它类似 PyTorch 的 `nn.Module`，但管理的不是神经网络层，而是：

- Predict

- LLM 调用

- Prompt Pipeline

- 多模块组合

- Callback

- Usage Tracking

- History

- 并行执行

本质上：

```
DSPy Module = LLM程序运行时容器
```

它负责：

```
输入
 ↓
Module.__call__
 ↓
forward
 ↓
Predict
 ↓
LM调用
 ↓
Prediction
```

【整体阅读顺序】

第一步先看：ProgramMeta

因为 DSPy 用了 metaclass 控制 Module 创建流程。

这是整个系统的入口。

  

第二步看：

```python
_base_init
__init__
```

理解：

Module 创建时会初始化什么。

核心属性：

```python
self._compiled
self.callbacks
self.history
```

这是所有 DSPy Module 的基础运行时状态。

  

第三步（最重要）看：

```
__call__
acall
forward
```

这是 DSPy 的执行主链路。

必须理解：

```
module(...)
    ↓
__call__
    ↓
forward()
    ↓
Predict
    ↓
LLM
```

DSPy 强调不要直接：

```python
module.forward()
```

而是：

```python
module(...)
```

因为`__call__` 内部还负责：

- callback

- tracing

- usage统计

- caller stack

- context

这些运行时逻辑。

  

第四步看：

```
named_predictors
predictors
map_named_predictors
```

这是DSPy 的 Predictor 管理系统。

DSPy optimizer 本质上就是修改 Predict，所以必须能遍历整个 Predictor 树。

  

第五步看：

```
set_lm
get_lm
```

这是整个 Program 的 LM 管理系统。

DSPy 的一个 Program可能包含多个 Predict，这些 Predict 可能共享同一个 LM。

所以Module 提供统一注入：

```
module.set_lm(lm)
```

  

第六步看：

```
batch
```

这是DSPy 的并行执行系统。

核心逻辑：

```python
exec_pairs= [(self,example.inputs())]
```

然后：

```python
Parallel.forward(...)
```

即批量并发执行：

```python
Module + Example.inputs()
```

这里labels 不参与推理，只用于评估。

  

第七步看：

```
inspect_history
_set_lm_usage
```

这是运行时监控系统。

`inspect_history`用于打印 LM 调用历史。

方便：

- Debug

- Prompt分析

- Trace分析

`_set_lm_usage`用于把：

```
token usage
cost
调用量
```

写入：

```
Prediction
```

因此Prediction 不只是输出。

还包含：

```
运行统计信息
```

  

第八步最后看：

```
__getattribute__
__getstate__
__setstate__
```

这是高级运行时控制。

`__getattribute__`

作用是检测用户是否：

```
module.forward()
```

直接调用。

DSPy 不推荐这种方式。

因为会绕过：

- callback

- tracing

- usage

- context

所以它会 warning。

`__getstate__`

`__setstate__`

用于pickle / 保存 / 恢复。

因为：

```
history
callbacks
```

通常不可序列化，所以保存时去掉，恢复时重新创建。

  

【整个 Module 的本质】

Module 不是普通类，而是：

```
LLM Runtime Container
```

它统一管理：

- Predict

- LM

- Prompt Pipeline

- Usage

- History

- Callback

- Parallel

- Serialization

- Optimization

DSPy 整个 Agent Runtime都是围绕 Module 构建的。

  

### `**code_interpreter.py**`

**抽象协议**：`CodeInterpret`（Protocol）、`CodeInterpreterError`、`FinalOutput`、`SIMPLE_TYPES`。定义「可插拔代码执行后端」的契约。

  

### `**python_interpreter.py**`

`**CodeInterpreter**` **的一种实现**（Deno/Pyodide 沙箱），依赖 `code_interpreter` 里的异常与类型。只有当你关心 **RLM / 代码执行** 时再细读；主线 **Module/Predict** 可以略读或跳过。

  

### `**repl_types.py**`

**REPL 状态与历史**（`REPLVariable`、`REPLEntry`、`REPLHistory`），服务 RLM/解释器交互；依赖面稍偏（例如用到 `dspy.adapters.utils`）。**放在两条 Interpreter 之后**即可。

  

## `**signatures/**`

`**Signature**`、字段定义：任务的「输入输出契约」从何而来。

###  `**__init__.py**`

这段 `__init__.py` 通过 `__all__`：

```python
__all__ = [
    "InputField",
    "OutputField",
    "OldField",
    "OldInputField",
    "OldOutputField",
    "SignatureMeta",
    "Signature",
    "infer_prefix",
    "ensure_signature",
    "make_signature",
]
```

对外导出了 10 个公共 API。

|导出名|来源文件|作用|
|---|---|---|
|InputField|field.py|定义输入字段|
|OutputField|field.py|定义输出字段|
|OldField|field.py|旧版兼容 Field|
|OldInputField|field.py|旧版兼容输入字段|
|OldOutputField|field.py|旧版兼容输出字段|
|SignatureMeta|signature.py|Signature 元类|
|Signature|signature.py|Signature 基类|
|infer_prefix|signature.py|推断 prompt 前缀|
|ensure_signature|signature.py|统一转换为 Signature|
|make_signature|signature.py|动态创建 Signature|

### `**field.py**`

这个代码文件负责“定义 Signature 的字段系统”

也就是：

```python
question = InputField()
answer = OutputField()
```

背后的实现。

这文件实际上分成 6 部分：

```
1. DSPy Field 参数定义
2. Pydantic 参数迁移
3. 约束翻译
4. InputField / OutputField
5. 新旧 Field 兼容
6. OldField 系统
```

#### （1）DSPy Field 系统的“元规则（metadata rules）”

```python
# The following arguments can be used in DSPy InputField and OutputField in addition
# to the standard pydantic.Field arguments. We just hope pydanitc doesn't add these,
# as it would give a name clash.
DSPY_FIELD_ARG_NAMES = ["desc", "prefix", "format", "parser", "__dspy_field_type", IS_TYPE_UNDEFINED]

_DEPRECATED_FIELD_ARGS = {
    "prefix": (
        "The 'prefix' argument in InputField/OutputField is deprecated and has no effect in DSPy. "
        "It will be removed in a future version."
    ),
    "format": (
        "The 'format' argument in InputField/OutputField is deprecated and has no effect in DSPy. "
        "It will be removed in a future version."
    ),
    "parser": (
        "The 'parser' argument in InputField/OutputField is deprecated and has no effect in DSPy. "
        "It will be removed in a future version."
    ),
}

PYDANTIC_CONSTRAINT_MAP = {
    "gt": "greater than: ",
    "ge": "greater than or equal to: ",
    "lt": "less than: ",
    "le": "less than or equal to: ",
    "min_length": "minimum length: ",
    "max_length": "maximum length: ",
    "multiple_of": "a multiple of the given number: ",
    "allow_inf_nan": "allow 'inf', '-inf', 'nan' values: ",
}
```

这些代码是DSPy 字段允许携带哪些额外信息”，以及“如何把 Python 类型约束翻译成 LLM 能理解的文本”。这是整个 Signature 系统的基础配置层。

DSPY_FIELD_ARG_NAMES 指明 DSPy 自己扩展出来的 Field 参数名列表

pydantic 原生并不认识：

```python
desc
prefix
parser
```

但是DSPy 需要支持类似下面的参数：

```python
InputField(desc="数学问题")
```

所以DSPy 必须维护一份“哪些参数属于 DSPy 自己”的名单。方便后面的move_kwargs()做参数分流。

实际上和代码里_DEPRECATED_FIELD_ARGS的说明一样，prefix、format、parser都已经被废弃。

PYDANTIC_CONSTRAINT_MAP是程序约束，但是llm看不懂，因此需要“程序 schema → prompt schema”的转换。

用户：

```python
age = InputField(gt=0,lt=120)
```

DSPy 后续：

```python
constraints= "greater than: 0, less than: 120"
```

然后 prompt 里可能：

```python
Age:
must be greater than 0
must be less than 120
```

  

#### （2）move_kwargs()：“DSPy Field → Pydantic Field”的桥接

move_kwargs 的作用是把 DSPy 自定义参数 迁移到 Pydantic 允许的位置

pydantic v2 不允许 Field 接收未知参数，自定义 metadata 必须放到：

```python
json_schema_extra={}
```

函数逻辑其实只有 4 步：

```
1. 分离 DSPy 参数
2. 分离 Pydantic 参数
3. 自动补充 schema 信息
4. 塞进 json_schema_extra
```

DSPy 实际上不重新实现类型系统，而是完全复用 Pydantic。

```
Python Type System
        ↓
Pydantic Schema
        ↓
DSPy Metadata
        ↓
Prompt Schema
        ↓
LLM
```

传统框架里 prompt 是字符串

DSPy 里 prompt 是 schema 的编译结果

  

#### （3）定义 DSPy Field 的运行行为

```python
1. 约束翻译
2. 废弃 API 警告
3. Input/OutputField 构建
4. 新旧字段兼容
5. OldField 老架构
```

**“程序约束 → 自然语言约束”：**

```python
def _translate_pydantic_field_constraints(**kwargs):
    """Extracts Pydantic constraints and translates them into human-readable format."""

    constraints = []
    for key, value in kwargs.items():
        if key in PYDANTIC_CONSTRAINT_MAP:
            constraints.append(f"{PYDANTIC_CONSTRAINT_MAP[key]}{value}")

    return ", ".join(constraints)
```

**Input/OutputField 构建：**

InputField 和 OutputField都是方法，而不是类

InputFeild本质上就是 Pydantic.Field 的 DSPy 包装器

用户：

```python
question=InputField(desc="数学问题")
```

最终：

```python
Field(
    json_schema_extra={
        "desc":"数学问题",
        "__dspy_field_type":"input"
    }
)
```

DSPy 根本没有自己实现字段系统，而是在 Pydantic Field 上挂 LM metadata。

这是非常聪明的设计。

**新旧字段兼容：**

解决prefix、format、parser废弃字段兼容问题

  

  

### `**signature.py**`

整个 DSPy 的核心思想是：

```
Signature
    ↓
Schema
    ↓
Prompt
    ↓
LLM Program
```

这个文件实际上分成：

```
1. Signature 元类系统（SignatureMeta）
2. Signature 类
3. Signature 动态编辑 API
4. Signature 构建器
5. String Signature Parser
6. Type Parser（AST）
7. Prefix 推断器
```

```python
class QA(dspy.Signature):
    question: str = InputField()
    answer: str = OutputField()
```

DSPy 看待它不是一个 schema

而是一个 LM 函数：

```python
f(question)→answer
```

代码中全局注释如下：

```python
"""DSPy 的 Signature（签名）类。

你通常会通过继承 Signature 类来定义自己的签名，例如：

    class MySignature(dspy.Signature):
        input: str = InputField(desc="...")
        output: int = OutputField(desc="...")

你也可以直接调用：

    Signature("input1, input2 -> output1, output2")

来创建一个新的 Signature 类型。

你还可以附带 instructions（指令），例如：

    Signature("input -> output", "This is a test")

不过，一般更推荐使用 make_signature 函数。

如果你不确定输入的是：
- 一个字符串形式的 Signature（例如 "input1, input2 -> output1, output2"）
- 还是一个已经定义好的 Signature 类，

那么你可以使用 ensure_signature 函数。

为了兼容旧版 dsp 格式，
你可以使用 signature_to_template 函数。
"""
```

#### Signature类

重点了解DSPy 想让用户怎么使用 Signature

理解DSPy 的 Signature不是静态 schema。，而是可编辑的 Prompt IR。

这个类本质上是在做Signature 的“结构变换”，即：

- 修改 instruction

- 动态增加字段

- 删除字段

- 调整字段顺序

- 比较两个 Signature 是否等价

- 保存 / 恢复 Signature 状态

这其实是 DSPy 能“自动优化 Prompt”的基础。

DSPy 的 Signature 不是普通数据类。

DSPy 会把它转成：

```
Inputs:
- question

Outputs:
- answer

Instructions:
...
```

然后生成 Prompt。

所以 Signature = Prompt 的结构化抽象。

```python
class Signature(BaseModel, metaclass=SignatureMeta):
```

说明Signature 本质上是Pydantic Schema

  

```python
@classmethod
def with_instructions(cls, instructions):
    return Signature(cls.fields, instructions)
```

```python
"""返回一个新的 Signature 类，该类拥有与当前类相同的字段，
但使用新的 instructions（指令）。

这个方法不会修改 `cls` 本身。
它会基于当前字段以及传入的 `instructions`
构造一个全新的 Signature 类。

参数：
    instructions (str):
        要附加到新 Signature 上的指令文本。

返回：
    一个新的 Signature 类：
    - 字段与 `cls.fields` 相同
    - instructions 等于传入的 `instructions`

示例：
```

import dspy

class MySig(dspy.Signature):

input_text: str = dspy.InputField(desc="输入文本")

output_text: str = dspy.OutputField(desc="输出文本")

NewSig = MySig.with_instructions("翻译成法语。")

assert NewSig is not MySig

assert NewSig.instructions == "翻译成法语。"

```python
"""
```

with_instructions方法复制原 Signature：

- 保留 fields

- 替换 instructions

  

```python
@classmethod
    def with_updated_fields(cls, name: str, type_: type | None = None, **kwargs: dict[str, Any]) -> type["Signature"]:
```

动态修改字段 metadata

```python
"""创建一个新的 Signature 类，并更新指定字段的信息。

该方法会返回一个新的 Signature 类，
其中字段 `name` 会按照：

    fields[name].json_schema_extra[key] = value

的方式进行更新。

参数：
    name:
        要更新的字段名称。

    type_:
        字段的新类型。

    kwargs:
        字段的新属性值。

返回：
    一个新的 Signature 类（不是实例），其中包含更新后的字段信息。
"""
```

举例如下：

```python
NewSig = MySig.with_updated_fields(
    "question",
    desc="A difficult reasoning question"
)
```

等价于：

```python
question: str = InputField(
    desc="A difficult reasoning question"
)
```

  

```python
@classmethod
    def prepend(cls, name, field, type_=None) -> type["Signature"]:
@classmethod
    def append(cls, name, field, type_=None) -> type["Signature"]:
@classmethod
    def insert(cls, index: int, name: str, field, type_: type | None = None) -> type["Signature"]:
```

上面三个方法都是增加字段，prepend在前面加，append在最后加，insert在任意位置加

  

```python
@classmethod
    def equals(cls, other) -> bool:
@classmethod
    def dump_state(cls):
@classmethod
    def load_state(cls, state):
```

equal方法比较：

- instructions

- field names

- field metadata

即只比较：json_schema_extra

dump_state方法实现Signature 序列化

load_state方法恢复 Prompt metadata。

  

#### make_signature()方法

该函数用于动态创建 Signature 类”的核心入口

```python
class MySig(dspy.Signature):
    question: str = dspy.InputField()
    answer: str = dspy.OutputField()
```

属于静态定义 Signature

而：

```python
make_signature(...)
```

属于运行时动态生成 Signature，这是 DSPy 能自动构造 Prompt Program 的核心能力之一。

这个函数本质上是在做：

```
输入：
    一个字段描述

输出：
    一个新的 Signature 类
```

即：

```
Schema Description
    ↓
Signature Class
```

整体流程其实非常清晰：

```
1. 解析 signature
2. 解析/修复字段
3. 自动生成 instructions
4. create_model 动态创建类
```

```python
"""根据指定的字段和 instructions（指令）创建一个新的 Signature 子类。

参数：
    signature:
        可以是以下两种形式之一：

        1. 字符串格式：
           "input1, input2 -> output1, output2"

        2. 字典格式：
           字段名映射到 `(type, FieldInfo)` 元组的字典。

    instructions:
        可选的字符串，
        用于作为该 Signature 的 instructions/prompt。

        如果未提供，
        会默认生成一个关于输入与输出字段的基础描述。

    signature_name:
        可选的字符串，
        用于指定生成的 Signature 子类名称。

        默认为 `"StringSignature"`。

    custom_types:
        可选字典，
        用于将类型名称映射到实际的 Python 类型对象。

        这对于解析：
        - 非内置类型
        - 不在 typing 模块中的自定义类型

        非常有用。

返回：
    一个新的 Signature 类，
    其中包含指定的字段与 instructions。

示例：
# 使用字符串格式

sig1 = make_signature(

"question, context -> answer"

)

# 使用字典格式

sig2 = make_signature({

"question": (str, InputField()),

"answer": (str, OutputField())

})

# 使用自定义类型

class MyType:

pass

sig3 = make_signature(

"input: MyType -> output",

custom_types={"MyType": MyType}

)
"""
```

  

#### _parse_signature()函数

是 DSPy Signature 系统里的“字符串 Signature DSL 解析器”

它负责把：

```
"question, context -> answer"
```

解析成：

```python
{
    "question": (str, InputField()),
    "context": (str, InputField()),
    "answer": (str, OutputField())
}
```

这是字符串 DSL → 结构化 Schema的关键一步。

  

#### _parse_field_string（）函数

把字段字符串解析成“字段名 + 类型”

例如：

```python
"x: int, y: list[str]"
```

会变成：

```python
[
    ("x",int,False),
    ("y",list[str],False),
]
```

其中：

```python
(field_name,field_type,is_type_undefined)
```

它没有自己手写 parser，而是借助 Python AST 解析函数参数

  

#### _parse_type_node（）函数

这个函数本质上是在 “解释 Python 类型 AST”

即：

```
字符串类型声明
    ↓
Python AST
    ↓
真实 Python Type
```

非常像微型编译器前端

  

#### _default_instructions函数

自动生成默认 Prompt instruction。

如果用户写：

```python
class QA(Signature):
    question: str = InputField()
    answer: str = OutputField()
```

但没写 docstring，DSPy 自动生成：

```
Given the fields `question`, produce the fields `answer`.
```

  

#### SignatureMeta类

负责“编译 Signature 类”

```python
class MySig(dspy.Signature):
    question: str = InputField()
    answer: str = OutputField()
```

真正干活的不是 `Signature，`而是`SignatureMeta`

因为Python 在创建类时：

```python
class MySig(...)
```

实际上会调用：

```python
SignatureMeta.__new__()
```

所以SignatureMeta = DSPy Signature 编译器

```python
def __call__(cls, *args, **kwargs):
        if cls is Signature:
            # We don't create an actual Signature instance, instead, we create a new Signature class.
            custom_types = kwargs.pop("custom_types", None)

            if custom_types is None and args and isinstance(args[0], str):
                custom_types = cls._detect_custom_types_from_caller(args[0])

            return make_signature(*args, custom_types=custom_types, **kwargs)
        return super().__call__(*args, **kwargs)
```

“调用类”时的行为

```python
Signature("x -> y")
```

不是创建实例，而是动态创建新 Signature 类

所以这里：

```python
if cls is Signature:
```

说明如果用户直接：

```python
Signature(...)
```

就走：

```python
make_signature(...)
```

即：

```python
Signature("question -> answer")
```

等价于：

```python
make_signature("question -> answer")
```

  

```python
@staticmethod
    def _detect_custom_types_from_caller(signature_str):
```

自动类型发现器

用户写：

```python
class MyType:
  pass

sig = Signature("x: MyType -> y")
```

但没传：

```python
custom_types={"MyType":MyType}
```

DSPy 会自动去调用栈找 MyType

  

## 第三层：单次推理主轴

## `**predict/**`

以 `**predict.py**` 里的 `**Predict**` 为主：**预处理 → Adapter → LM → Prediction** 的枢纽都在这里。

### **第一层：全貌与底座**

#### `**__init__.py**`

```python
__all__ = [
    "majority",
    "BestOfN",
    "ChainOfThought",
    "CodeAct",
    "KNN",
    "MultiChainComparison",
    "Predict",
    "ProgramOfThought",
    "ReAct",
    "Refine",
    "RLM",
    "Tool",
    "Parallel",
]
```

大致可以理解为：

```
                Predict
                   |
    --------------------------------
    |              |              |
   CoT           ReAct         Refine
    |                              |
BestOfN                    MultiChain
    |
majority
```

而：

```
ProgramOfThought
CodeAct
RLM
```

属于Execution-Augmented Reasoning路线。

  

#### `**parameter.py**`

就一个 `**Parameter**` **占位基类**：`Predict` 用 **多重继承** `**Module + Parameter**` 混入「可优化参数体」语义。

  

  

### **第二层：核心（必读）**

#### `**predict.py**`

**整包主轴**：`_forward_preprocess` → `adapter` → `_forward_postprocess`、`demos`/`signature`/`lm`、

`dump_state`/`load_state` 等都在这里。不设这一条，后面所有「包一层 Predict」的文件都不好懂。

> 把“结构化 Signature + LM + Prompt Adapter + 输出解析”封装成一个统一 Module。

即：

```
输入 kwargs
    ↓
根据 Signature 检查输入
    ↓
构造 Prompt
    ↓
调用 LM
    ↓
解析输出
    ↓
返回 Prediction
```

这是 DSPy 最底层的“单次推理执行引擎”

这份代码其实可以分成：

```
1. imports
2. 全局工具函数
3. Predict 类
4. 类型检查工具
5. serialize 工具
```

真正核心只有 Predict 类，其他都是 supporting utilities。

predict类的注释如下：

```python
"""一个基础的 DSPy 模块，
用于通过语言模型（Language Model）将输入映射为输出。

参数：
    signature:
        描述任务输入/输出结构的 Signature。

    callbacks:
        可选的回调函数列表，
        用于监控、日志记录或埋点（instrumentation）。

    **config:
        默认会传递给底层语言模型的关键字参数。

        这些默认配置可以在单次调用时，
        通过传入 `config` 字典进行覆盖。

        例如：

        ```python
        predict = dspy.Predict(
            "q -> a",
            rollout_id=1,
            temperature=1.0
        )

        predict(
            q="What is 1 + 52?",
            config={
                "rollout_id": 2,
                "temperature": 1.0
            }
        )
        ```
"""
```

核心代码阅读顺序如下：

```python
1. _forward_preprocess
2. _forward_postprocess
3. forward
```

（1） _forward_preprocess

它的本质作用：

在真正调用 LLM 前，完成所有“执行环境准备”

包括：

```
1. 提取特殊参数
2. 选择 LM
3. 合并配置
4. 修正采样参数
5. 处理 predicted outputs
6. 补全默认输入
7. 检查非法字段
8. 类型检查
9. 缺失字段检查
```

最后返回：

```python
(lm,config,signature,demos,kwargs)
```

供 forward() 继续执行。

整体流程：

```
Predict.forward()
    ↓
_forward_preprocess()   ← 你现在看的
    ↓
adapter(...)
    ↓
LM.generate()
    ↓
Prediction.parse()
```

它是“LLM 调用前的总准备器”

  

（2）_forward_postprocess

它的作用只有两件事：

```
1. 把 LM 原始输出解析成 Prediction
2. 把这次调用记录到 trace
```

然后返回 Prediction

  

（3）forward 和 aforward

这两个方法本质上就是 DSPy Predict 的“真正执行主链”

这两个函数在做：

```
1. 预处理输入
2. 选择 Prompt Adapter
3. 调用 LLM
4. 后处理输出
```

即 DSPy Runtime Pipeline 如下：

```
用户输入 kwargs
        ↓
_forward_preprocess
        ↓
Adapter 编译 Prompt
        ↓
LM.generate()
        ↓
completion
        ↓
_forward_postprocess
        ↓
Prediction
```

  

### **第三层：与 Predict 并行、较独立的小模块**

####  `**parallel.py**`

对 **一堆 (module, example)** 做并行执行，用的是 `settings`、`ParallelExecutor`，**不加深** `**Predict**` **内部**，但和很多评估/编译流程一起看时有用。

把：

```
(module,example)
```

这样的任务对，用多线程并发执行。例如：

```python
[(Predict1,ex1),
 (Predict1,ex2),
 (Predict2,ex3)]
```

它会：

- 自动开线程池

- 并发调用 module

- 收集结果

- 处理异常

- 统计失败样本

- 控制最大错误数

- 超时控制

- 进度条控制

本质上它是 DSPy 的“批量推理调度器”，很多 Evaluate / BootstrapFewShot / Teleprompt / Dataset Evaluate 都依赖它。

  

#### `**aggregation.py**`

`**majority**`：对 `**Prediction**` **/** `**Completions**` **/ list** 做多条 completion 投票，依赖 `**primitives.prediction**` 里的结构。和单次 `Predict.forward` 正交，随时可读。

这段代码实现的是DSPy 的“多数投票（Majority Voting）”

核心作用：

> 从多个 LM completion（候选输出）中，
> 
> 选出“出现次数最多”的那个答案。

这是 DSPy 里Self-Consistency（自一致性）机制的核心基础函数之一。

  

### **第四层：在** `**Predict**` **外面的「签名扩展 + 一次 LM」**

（模式：`ensure_signature` 改签名 → `self.predict = Predict(...)` → `forward` 里调用）

#### `**chain_ofThought.py**`

在签名前加一个 **reasoning 输出**，再 `**dspy.Predict(extended_signature)**`。最短的「Predict 包装器」范例。

原任务：

```python
"question -> answer"
```

CoT 自动变成：

```python
"question -> reasoning, answer"
```

然后：

```python
Predict(...)
```

去生成：

```python
{
   "reasoning": "...step by step...",
   "answer": "42"
}
```

这就是DSPy 的 CoT 本质

  

#### `**multi_chain_comparison.py**`

多路 **reasoning attempt** + 聚合式签名，仍然是 `**Predict**` **兜底**，适合对照 `ChainOfThought` 看多字段签名怎么拼。

不直接对多个答案做 majority vote，而是：

让一个新的 LLM阅读多个 reasoning chain

然后综合判断谁更合理，再重新生成最终答案。

这是Self-Consistency 的升级版

也是现代：

- Reflection

- Debate

- Judge Model

- Tree Search

- Ensemble Reasoning

的重要基础。

  

### **第五层：对任意** `**Module**` **做重试 / 采样**

####  `**best_of_n.py**`

对子 `**Module**` 多次运行 + `**reward_fn**`**/**`**threshold**`，不依赖你了解 `Predict` 以上细节，但需要已读过 `**module.py**`**（primitives）** 和 `**Prediction**`。

同一个任务，让 LLM 多次采样（multiple rollouts），然后用 reward function 评分，选择最好的那个结果。

这是现代 LLM 推理系统里：Sampling + Reranking范式的核心实现。

普通调用：

```python
pred = module(question=q)
```

BestOfN：

```
生成N个candidate
↓
reward_fn打分
↓
返回reward最高的
```

即：Search over reasoning trajectories

  

####  `**refine.py**`

带 **反馈 Signature**、`OfferFeedback` 等，偏重「程序级纠错」；体量较大，放 `BestOfN` 后面即可。

本质上是基于反馈的自反思优化（Reflection-based Refinement）

或者更准确说是LLM-driven trajectory refinement

这是：

- Self-Refine

- Reflexion

- Constitutional AI

- Verbal Reinforcement Learning

- Test-Time RL

这一类工作的核心思想。

BestOfN：

```
多次采样
↓
reward 打分
↓
选最优
```

但不会学习失败经验

Refine：

```
失败
↓
分析失败原因
↓
生成自然语言反馈
↓
把反馈注入下一轮推理
↓
再次尝试
```

即：Verbal Reinforcement Learning

Refine 做的不是：

```
gradient update
```

而是用自然语言更新策略

即：

```
失败轨迹
↓
LLM critic
↓
自然语言 advice
↓
下一轮 reasoning hint
```

这已经是现代 Agent Reflection 核心范式

  

### **第六层：工具循环 / 代码执行（Agent 向）**

####  `**react.py**`

**ReAct**：工具 + 多轮循环，内部自己调 LM / 工具；读前需熟悉 `**Signature**`、`dspy.adapters.types.tool.Tool`。

迭代式 Tool-Using Agent

核心思想：

```
Reason
↓
Act
↓
Observe
↓
Reason
↓
Act
```

这其实已经：非常接近现代 Agent 系统核心结构，包括：

- Deep Research

- AutoGPT

- LangGraph Agent

- OpenAI tool-agent

- Claude tool use

- Gemini Deep Think

的基础 runtime。

  

####  `**program_of_thought.py**`

**ProgramOfThought**：生成代码 + `**PythonInterpreter**`，依赖 `**primitives**` **里解释器**。

核心思想：不直接让 LLM 推理答案

而是：让 LLM 写 Python 程序来求解问题

即：

```
Question
   ↓
Generate Python Code
   ↓
Execute Code
   ↓
Observe Result
   ↓
Generate Final Answer
```

这是：Tool-Augmented Reasoning 的重要路线。

也是现代：

- OpenAI Code Interpreter

- Claude Code

- Deep Research

- Toolformer

- PAL

- Program-of-Thought

的核心思想。

PoT其实是：“生成代码 → 执行 → 修复 → 输出”流水线。

完整流程：

```
Question
   ↓
LLM 生成代码
   ↓
Python 执行
   ↓
成功？
 ┌─────────────┐
 │             │
 NO            YES
 │             │
错误反馈        最终答案生成
 │             │
LLM 修复代码     Return
 │
重新执行
```

这已经非常像 Autonomous Coding Agent了。

  

#### `**code_act.py**`

**多重继承** `**ReAct, ProgramOfThought**`，把「工具 ReAct」和「代码 PoT」合在一起，**必须放在** `**react**` **和** `**program_of_thought**` **之后**。

它本质上是ReAct + ProgramOfThought 的融合体

即：

```
ReAct:
thought -> tool -> observation

+
ProgramOfThought:
generate code -> execute code
```

最终形成“通过写代码来行动”的 Agent。

普通 ReAct：LLM选择工具调用

例如：

```
tool = search
args = ...
```

CodeAct：

```
LLM:
直接写 Python 代码来调用工具
```

例如：

```
weather=get_weather("Tokyo")
population=get_population("Tokyo")
print(weather,population)
```

即：action language 从 JSON 变成 Python这是巨大升级。

  

### **第七层：其它与扩展**

#### `**knn.py**`

**KNN + Embedder** 在 trainset 上检索相似例，**不是**典型「包 Predict」；更像独立小工具。需要 KNN few-shot 时再读，顺序可插在 `parallel` 前后均可。

#### `**rlm.py**`

**RLM** 体积大、依赖多（`Tool`、`PythonInterpreter`、`repl_types`、`CodeInterpreter` 等），建议主线都读完再啃。

#### `**predict/avatar/**`

`**signatures.py**` **→** `**models.py**` **→** `**avatar.py**` **→** `**__init__.py**`（若你关心 Avatar 这条产品线）。

  

## `**adapters/**`

先 `**base.py**`（整条 format / parse / preprocess 管线），再 `**chat_adapter.py**`（默认实现）。需要多模态/特殊类型时再进 `**adapters/types/**`。

###  `**__init__.py**`

对外导出：`Adapter`、`ChatAdapter`、`JSONAdapter`、`TwoStepAdapter`、`XMLAdapter`、各类 `types`。先扫一眼即可。

```python
__all__ = [
    "Adapter",
    "ChatAdapter",
    "Type",
    "History",
    "Image",
    "Audio",
    "File",
    "Code",
    "JSONAdapter",
    "XMLAdapter",
    "TwoStepAdapter",
    "Tool",
    "ToolCalls",
    "Reasoning",
]
```

Adapter 负责：

```
Signature
    ↓
Prompt Format
    ↓
LM API
    ↓
Parse Output
```

  

### `**types/**`

**在** `**Signature**` **的字段类型里使用的「富类型」**——都继承 `base_type.py` 里的 `**Type**`**（Pydantic 模型）**，负责 `**format()**` 成发给大模型的 content 片段、以及部分类型上的 **原生能力 / 流式 / 解析** 钩子。

**公开导出（**`**__init__.py**` **的** `**__all__**`**）**

|**模块**|**作用（概括）**|
|---|---|
|`**base_type.py**`|基类 `**Type**`；`**split_message_content_for_custom_types**`（把带占位标记的长字符串拆成多段 content）；双重 JSON 解析辅助。|
|`**image.py**`|`**Image**`：图片 URL/base64 等 → 多模态消息块。|
|`**audio.py**`|`**Audio**`：音频输入格式化。|
|`**file.py**`|`**File**`：文件类输入。|
|`**history.py**`|`**History**`：多轮对话历史放进 prompt 的结构。|
|`**tool.py**`|`**Tool**`（可执行工具描述）、`**ToolCalls**`（模型返回的工具调用列表）。|
|`**code.py**`|`**Code**`：签名字段里表示「一段代码」及 schema/描述。|
|`**reasoning.py**`|`**Reasoning**`：推理/思考块，常与 `**adapt_to_native_lm_feature**` 等配合。|

**同目录但未进上面** `**__all__**` **的文件**

|**文件**|**作用（概括）**|
|---|---|
|`**document.py**`|`**Document**`：可引用文档块（偏 Citations / 长上下文）。|
|`**citation.py**`|`**Citations**`：从带引文的响应里解析引用。|

这类通常通过 `**dspy.experimental**` 或其它入口再导出，而不是 `adapters.types` 的顶层 `__all__`。

  

### `**utils.py**`

**字段格式化、类型注解 stringify、解析、JSON schema、**`**format_field_value**`

 **/** `**parse_value**` **/** `**translate_field_type**` **/** `**get_field_description_string**` 等。`**chat_adapter**` **/** `**json_adapter**` **/** `**xml_adapter**` 都会大量用这里。体量较大，可分块：`**serialize_for_json**` 

**→** `**format_field_value**`**→** `**parse_value**` **→** `**translate_field_type**` **/** `**get_annotation_name**` **/** `**get_field_description_string**`。

  

###  `**base.py**`

`**Adapter**`：`__call__` / `acall` 流水线、`**_call_preprocess**`（工具调用 / `native_response_types`）、`**format**` **默认实现**（system + demos + user，最后 `**split_message_content_for_custom_types**`）、`**_call_postprocess**`、抽象 `**format_system_message**` **/** `**parse**` 等。

adapter的作用是：

- “把 Signature + 输入数据 → 变成 LM 能读的 prompt”

- “把 LM 输出 → 解析回结构化字段”

DSPy 的整体流水线：

```
DSPy Module
    ↓
Signature
    ↓
Adapter   ← 你现在看的
    ↓
LM API
    ↓
Adapter.parse()
    ↓
Prediction
```

也就是说：Adapter 是「DSPy 抽象任务」 和 「真实 LLM API」之间的桥梁。它解决：

结构化 Python 世界 和 自然语言 Prompt 世界之间的转化。

这个类主要负责：

|功能|作用|
|---|---|
|format|构造 prompt|
|parse|解析输出|
|demos|few-shot|
|history|对话历史|
|tools|function calling|
|reasoning|reasoning字段|
|citations|citation字段|
|custom types|Image/Audio/File 等|

很多人以为 DSPy 核心是：

```python
Predict("q -> a")
```

其实真正核心是：Signature + Adapter

因为：

```
Signature
定义:
    输入输出结构

Adapter
定义:
    如何变成 prompt
```

这就是“声明式 Prompt 编程”。

  

### `**chat_adapter.py**`

默认路径：**在** `**Adapter**` **之上实现** field header、`[[ ## ... ## ]]`、与 `**JSONAdapter**` **回退** 等。读懂它等于读懂「DSPy 默认怎么跟 Chat 模型说话」。

输入：

```python
dspy.Predict("question -> answer")
```

最终会生成：

```python
system:
Your input fields are:
...

user:
[[ ## question ## ]]
What is 2+2?

assistant:
[[ ## answer ## ]]
4
[[ ## completed ## ]]
```

很多 Prompt：

```
Q:
A:
```

容易：

- 混字段

- 输出漂移

- 多字段困难

- parse困难

DSPy 解决方法是使用强结构化字段分隔符

即：

```
[[ ## field ## ]]
```

这就是ChatAdapter 的核心设计

  

###  `**json_adapter.py**`

`**class JSONAdapter(ChatAdapter)**`：在 Chat 流程上改成 **JSON 结构化** 的 format/parse。`ChatAdapter` 失败时也会回落到它，所以放在 `**chat_adapter**` **之后**。

它负责把 DSPy 的 Signature 转成 “JSON 风格的 Prompt + Structured Output约束”，并把 LLM 输出重新解析成 Python 对象。

可以把它理解成：

```
DSPy Signature
      ↓
JSONAdapter
      ↓
Prompt / response_format / schema
      ↓
LLM
      ↓
JSONAdapter.parse()
      ↓
Python dict / typed object
```

它本质上是：

```
ChatAdapter 的 JSON 强化版
```

相比 `ChatAdapter`：

- ChatAdapter：  
    用 `[[ ## field ## ]]` 文本格式约束输出

- JSONAdapter：  
    直接要求模型输出 JSON
    
    - 使用 OpenAI Structured Outputs
    
    - 使用 Pydantic Schema
    

这是 DSPy 现代结构化输出的核心。

整个文件可以分成：

```
1. open-ended mapping 检查
2. JSONAdapter 类
    ├── call流程
    ├── prompt格式化
    ├── JSON解析
    └── finetune接口
3. Structured Outputs Schema生成器
```

  

### `**xml_adapter.py**`

`**class XMLAdapter(ChatAdapter)**`：XML 标签包字段。依赖 `**ChatAdapter**` **+** `**utils**`，放在 JSON 之后或与之并列（二选一先后即可）。

这个 `XMLAdapter` 本质上是：ChatAdapter 的 XML 版本

它做的事情非常简单：

```
把 DSPy Signature
包装成 XML Prompt

并要求模型输出 XML

然后再把 XML 解析回 Python 对象
```

  

###  `**baml_adapter.py**`

`**class BAMLAdapter(JSONAdapter)**`：BAML 风格 prompt，基于 `**JSONAdapter**`。需先理解 **JSON 路径**。

这一部分本质上是：

> DSPy 对 `JSONAdapter` 的进一步增强版 —— 专门优化 “复杂 Pydantic 结构输出” 的 Prompt 表达。

```
普通 JSONAdapter
    ↓
告诉模型：
输出 JSON

BAMLAdapter
    ↓
不仅告诉模型输出 JSON
还把复杂结构“翻译成更适合 LLM 理解的 schema 文本”
```

核心目标：

```
提升复杂结构化输出稳定性
特别是：
- 小模型
- 深层嵌套 JSON
- Pydantic BaseModel
- Union / Optional / Literal
```

整个文件：

```
_render_type_str()
    ↓
_build_simplified_schema()
    ↓
BAMLAdapter(JSONAdapter)
```

本质是：

```
Python Type Annotation
    ↓
渲染成人类友好的 schema
    ↓
塞进 prompt
    ↓
让 LM 更容易输出正确 JSON
```

#### _render_type_str函数

这是整个文件最重要的函数。

作用：

```
把 Python 类型
递归转换为“LLM友好的 schema 文本”
```

#### _build_simplified_schema函数

真正构造类 JSON 的 schema 文本

例如：

```python
class User(BaseModel):
    name: str
    age: int
```

输出：

```python
{
  name: string,
  age: int,
}
```

  

### `**two_step_adapter.py**`

`**class TwoStepAdapter(Adapter)**`：主模型 + 小模型二次抽取结构；用 `**ChatAdapter**` 等拼第二步。依赖 `**base**` **+** `**chat_adapter**`，适合最后当「组合用法」读。

它解决的问题本质是：

```
“推理能力强的模型”
往往
“不擅长严格结构化输出”
```

例如：

- o1

- o3

- DeepSeek-R1

- Claude reasoning

- Gemini thinking

这些模型：

```
推理非常强
但：
JSON 经常不合法
字段缺失
格式漂移
```

于是 DSPy 提出了：

```
推理
和
结构化解析

拆成两个模型
```

整体架构：

```
                第一阶段
         （大推理模型自由生成）

Input
  ↓
Main LM
(o1/o3/R1)
  ↓
长篇自然语言推理
  ↓

                第二阶段
          （小模型结构化提取）

Raw Text
  ↓
Extractor LM
(gpt-4o-mini)
  ↓
Structured Output
```

即：

```
Reasoning LM
负责“思考”

Extraction LM
负责“格式化”
```

这是非常经典的：

```
Reasoning / Extraction 解耦
```

  

## `**clients/**`

`**lm.py**`、`**base_lm.py**`：请求怎么出去、缓存与重试在哪儿。

`**__init__.py**` **→** `**disk_serialization.py**` **→** `**cache.py**` **→** `**base_lm.py**` **→** `**utils_finetune.py**` **→** `**provider.py**` **→** `**openai.py**`**（+ 按需** `**lm_local**` **/** `**databricks**`**）→** `**lm.py**` **→** `**embedding.py**`

若只关心 **Predict 调模型**：`**base_lm**` **+** `**cache**`**（略读）+** `**lm**` 即可；微调与平台相关文件可整包后移。

###  `**__init__.py**`

默认 `**DSPY_CACHE**`、`**configure_cache**`、关闭 LiteLLM 自带 cache、`**litellm**` **日志** 等全局行为；并导出 `**BaseLM**`**、**`**LM**`**、**`**Embedder**`**、**`**Provider**`**、**`**TrainingJob**`。先扫一遍，后面看到 `dspy.cache` 会知道从哪来。

  

### `**base_lm.py**`

`**BaseLM**`：构造函数里 `**model**` **/** `**model_type**` **/** `**kwargs**` **/** `**history**`；`**forward**`**/**`**__call__**`**/**`**acall**` 的形态约定；`**supports_function_calling**` 等与 Adapter 对齐的能力位；全局 `**inspect_history**` 等。**不依赖**本目录其它实现文件（只依赖 settings/callback），应作为 **LM 侧的「协议」最先吃透**。

````python
"""用于处理 LLM（大语言模型）调用的基类。

大多数用户可以直接使用 `dspy.LM` 类，它是 `BaseLM` 的一个子类。

用户也可以继承 `BaseLM`来实现自己的自定义 LLM Provider，或者注入自定义逻辑。

如果要这样做，只需要重写 `forward` 方法，并确保返回格式与：

OpenAI Response Format保持一致。

示例：

```python
from openai import OpenAI

import dspy


class MyLM(dspy.BaseLM):

    @property
    def supports_function_calling(self) -> bool:
        return self.model.startswith("openai/gpt-4o")

    @property
    def supports_reasoning(self) -> bool:
        return self.model.startswith("anthropic/claude-3-7")

    @property
    def supports_response_schema(self) -> bool:
        return self.model.startswith("openai/gpt-4o")

    @property
    def supported_params(self) -> set[str]:
        if self.model.startswith("openai/gpt-4o"):
            return {"response_format"}  # 支持 response_format=...
        return set()

    def forward(self, prompt, messages=None, **kwargs):
        client = OpenAI()

        return client.chat.completions.create(
            model=self.model,
            messages=messages or [
                {"role": "user", "content": prompt}
            ],
            **self.kwargs,
        )


lm = MyLM(model="gpt-4o-mini")

dspy.configure(lm=lm)

print(
    dspy.Predict("q->a")(
        q="Why did the chicken cross the kitchen?"
    )
)
"""
````

DSPy 所有模型调用的统一抽象接口

这个类本质上是：

```
“所有 LLM Provider 的统一运行时协议”
```

即：

```
OpenAI
Claude
Gemini
DeepSeek
Ollama
vLLM
Together
...
```

最终都会被包装成BaseLM统一接口。

完整主线：

```
Predict
   ↓
Adapter
   ↓
LM
   ↓
BaseLM
   ↓
LiteLLM/OpenAI SDK
   ↓
Model Provider
```

其中BaseLM 是“DSPy 与所有模型后端之间的抽象边界”

  

## `**lm.py**`

`**class LM(BaseLM)**`：LiteLLM 调用、重试、`copy(rollout_id=...)`、与 `**Provider**`**/微调** 的衔接、`**request_cache**` 包一层等。**应放在** `**base_lm**` **+** `**cache**` **+（至少）**`**openai**` **的** `**Provider**` **之后**。

这个类本质上是：

```
DSPy 的“统一 LLM Runtime Engine”
```

负责：

- provider routing

- cache

- retry

- streaming

- usage tracking

- responses api

- reasoning model handling

- finetune

- RL

- async

- truncation recovery

真正全链路：

```
Predict.forward()
    ↓
Adapter.format()
    ↓
LM.__call__()
    ↓
LM.forward()
    ↓
litellm_completion()
    ↓
LiteLLM
    ↓
Provider API
```

然后：

```
Provider Response
    ↓
BaseLM._process_lm_response()
    ↓
Prediction
```

  

## 第四层：优化与评估（「compile」怎么走）

## `**teleprompt/**`

先看 `**teleprompt.py**`（`Teleprompter.compile` 契约），再 `**bootstrap.py**`（demos/trace 最典型的路径），其它优化器（`gepa/`、`mipro_optimizer_v2.py` 等）按兴趣横向对比。

###  `**teleprompt.py**`

```python
from typing import Any

from dspy.primitives import Example, Module


class Teleprompter:
    def __init__(self):
        pass

    def compile(self, student: Module, *, trainset: list[Example], teacher: Module | None = None, valset: list[Example] | None = None, **kwargs) -> Module:
        """
        Optimize the student program.

        Args:
            student: The student program to optimize.
            trainset: The training set to use for optimization.
            teacher: The teacher program to use for optimization.
            valset: The validation set to use for optimization.

        Returns:
            The optimized student program.
        """
        raise NotImplementedError

    def get_params(self) -> dict[str, Any]:
        """
        Get the parameters of the teleprompter.

        Returns:
            The parameters of the teleprompter.
        """
        return self.__dict__
```

`**Teleprompter**` **抽象基类**：定义 `**compile(student, trainset, …)**` 形态；具体逻辑由子类实现。  
  

### `**vanilla.py**`

DSPy 的第一个真正 Optimizer

这个类本质上是：

```
“最简单的 Few-Shot Prompt 编译器”
```

它做的事情：

```
从 trainset 里挑 K 个 example
    ↓
挂到 predictor.demos
    ↓
形成 few-shot prompt
```

```python
class LabeledFewShot(Teleprompter):
    def __init__(self, k=16):
        self.k = k

    def compile(self, student, *, trainset, sample=True):
        self.student = student.reset_copy()
        self.trainset = trainset

        if len(self.trainset) == 0:
            return self.student

        rng = random.Random(0)

        for predictor in self.student.predictors():
            if sample:
                predictor.demos = rng.sample(self.trainset, min(self.k, len(self.trainset)))
            else:
                predictor.demos = self.trainset[: min(self.k, len(self.trainset))]

        return self.student
```

  

### `**bootstrap.py**`

`**BootstrapFewShot**`：teacher 跑程序 + `**metric**` **+** `**trace**`，把通过的步聚成 **bootstrapped demos**，再和 labeled 拼进 **student 的** `**predictor.demos**`（最典型 teleprompt 路径）。  
  
DSPy 第一代“真正智能”的 compile 系统.

BootstrapFewShot = 用 Teacher 自动生成高质量 reasoning traces

```python
Teacher Program
    ↓
生成 reasoning trace
    ↓
trace 变成 demos
    ↓
优化 Student Program
```

```python
def compile(self, student, *, teacher=None, trainset):
    self.trainset = trainset

    self._prepare_student_and_teacher(student, teacher)
    self._prepare_predictor_mappings()
    self._bootstrap()

    self.student = self._train()
    self.student._compiled = True

     return self.student
```

```python
整个 compile：

_prepare_student_and_teacher()
    ↓
_prepare_predictor_mappings()
    ↓
_bootstrap()
    ↓
_train()
```

#### _prepare_student_and_teacher方法

```python
    def _prepare_student_and_teacher(self, student, teacher):
        self.student = student.reset_copy()

        # NOTE: behavior change on Oct 28, 2024. Deep copy instead of reset copy for the student-as-teacher.
        self.teacher = teacher.deepcopy() if teacher is not None else student.deepcopy()

        assert getattr(self.student, "_compiled", False) is False, "Student must be uncompiled."

        if self.max_labeled_demos and getattr(self.teacher, "_compiled", False) is False:
            teleprompter = LabeledFewShot(k=self.max_labeled_demos)
            self.teacher = teleprompter.compile(self.teacher.reset_copy(), trainset=self.trainset)
```

如果 teacher 没 compile 过，先给 teacher基础 few-shot

#### _prepare_predictor_mappings方法

```
建立 Student Program 与 Teacher Program 中 predictor 节点的对应关系
```

它本质上是在做Program Graph Alignment（程序图对齐）

后面 bootstrap 时：

```
Teacher运行
↓
产生trace
```

trace 里面只有predictor object

例如：

```
(predictor,inputs,outputs)
```

但是DSPy 最后需要：

```
把 Teacher trace
注入 Student predictor.demos
```

所以必须知道这个 trace 属于哪个 predictor 节点

#### _bootstrap方法

整个逻辑本质：

```
对每个训练样本：
    用 Teacher 执行
        ↓
    收集 reasoning trace
        ↓
    metric 判断 trace 是否好
        ↓
    好 trace 转成 demos
        ↓
    注入 Student predictors
```

max_bootstraps是采样数

bootstrapped记录哪些 train examples 已成功 bootstrap

```python
self.name2traces = {
   name: []
}
```

这是Predictor-level Trace Storage

即：每个 predictor都有自己的 trace demos

例如：

```python
{
   "retrieve": [...],
   "reason": [...],
}
```

核心循环如下：

```python
for example_idx, example in trainset
```

对每个训练样本尝试生成高质量 reasoning trace

#### _bootstrap_one_example方法

尝试把一个 train example蒸馏成高质量 reasoning demos

返回：True/False

表示：是否 bootstrap 成功

name2traces临时存储当前 example 产生的 traces，格式如下：

```python
{
   predictor_name: [demo1, demo2]
}
```

trace 最终结构：

```python
[
   (predictor,inputs,outputs),
   ...
]
```

例如：

```python
[
   (
      retrieve_predictor,
      {"question": "..."},
      {"passages": "..."}
   ),

   (
      reason_predictor,
      {"question": "...", "passages": "..."},
      {"answer": "..."}
   )
]
```

  

### `**bootstrap_trace.py**`

`**bootstrap_trace_data**` 及 `**TraceData**` **/** `**FailedPrediction**`：在数据集上跑 program、收集 **逐条 trace 与分数**，便于后续分析或与训练流水线对接（偏「离线造 trace 数据」）。  
  
把“trace 收集”抽象成通用基础设施

旧版：BootstrapFewShot自己写 trace 收集逻辑

新版：bootstrap_trace_data()统一收集 traces

这是 Trace Collection Infrastructure

```python
class TraceData(TypedDict):
```

本质是一条 trajectory 样本 包含：

```python
{
   example_ind,
   example,
   prediction,
   trace,
   score
}
```

即：

```
(input, output, reasoning_trajectory, reward)
```

这已经是 RL Dataset

```python
@dataclass
class FailedPrediction:
```

这是parse-failure-aware training

LLM 经常输出格式错误

例如应该：

```python
{
   "answer":"Paris"
}
```

实际：

```
The answer is Paris.
```

DSPy：

```
把 failure 也纳入 trajectory
```

这是 RL-friendly design

  

### `**bootstrap_finetune.py**`

“先让 teacher program 跑训练集收集高质量 trace → 再把 trace 转成 SFT/Fine-tune 数据 → 最后自动微调 student 使用的 LM”

```python
def compile(
        self, student: Module, trainset: list[Example], teacher: Module | list[Module] | None = None
    ) -> Module:
        # TODO: Print statements can be converted to logger.info if we ensure
        # that the default DSPy logger logs info level messages in notebook
        # environments.
        logger.info("Preparing the student and teacher programs...")
        all_predictors_have_lms(student)

        logger.info("Bootstrapping data...")
        trace_data = []

        teachers = teacher if isinstance(teacher, list) else [teacher]
        teachers = [prepare_teacher(student, t) for t in teachers]
        num_threads = self.num_threads or dspy.settings.num_threads
        for t in teachers:
            trace_data += bootstrap_trace_data(program=t, dataset=trainset, metric=self.metric, num_threads=num_threads)

        logger.info("Preparing the train data...")
        key_to_data = {}
        for pred_ind, pred in enumerate(student.predictors()):
            data_pred_ind = None if self.multitask else pred_ind
            if pred.lm is None:
                raise ValueError(
                    f"Predictor {pred_ind} does not have an LM assigned. "
                    f"Please ensure the module's predictors have their LM set before fine-tuning. "
                    f"You can set it using: your_module.set_lm(your_lm)"
                )
            training_key = (pred.lm, data_pred_ind)

            if training_key not in key_to_data:
                train_data, data_format = self._prepare_finetune_data(
                    trace_data=trace_data, lm=pred.lm, pred_ind=data_pred_ind
                )
                logger.info(f"Using {len(train_data)} data points for fine-tuning the model: {pred.lm.model}")
                finetune_kwargs = {
                    "lm": pred.lm,
                    "train_data": train_data,
                    "train_data_format": data_format,
                    "train_kwargs": self.train_kwargs[pred.lm],
                }
                key_to_data[training_key] = finetune_kwargs

        logger.info("Starting LM fine-tuning...")
        # TODO(feature): We could run batches of fine-tuning jobs in sequence
        # to avoid exceeding the number of threads.
        if len(key_to_data) > num_threads:
            raise ValueError(
                "BootstrapFinetune requires `num_threads` to be bigger than or equal to the number of fine-tuning "
                f"jobs. There are {len(key_to_data)} fine-tuning jobs to start, but the number of threads is: "
                f"{num_threads}! If the `multitask` flag is set to False, the number of fine-tuning jobs will "
                "be equal to the number of predictors in the student program. If the `multitask` flag is set to True, "
                "the number of fine-tuning jobs will be equal to: 1 if there is only a context LM, or the number of "
                "unique LMs attached to the predictors in the student program. In any case, the number of fine-tuning "
                "jobs will be less than or equal to the number of predictors."
            )
        logger.info(f"{len(key_to_data)} fine-tuning job(s) to start")
        key_to_lm = self.finetune_lms(key_to_data)

        logger.info("Updating the student program with the fine-tuned LMs...")
        for pred_ind, pred in enumerate(student.predictors()):
            data_pred_ind = None if self.multitask else pred_ind
            training_key = (pred.lm, data_pred_ind)
            finetuned_lm = key_to_lm[training_key]
            if isinstance(finetuned_lm, Exception):
                raise RuntimeError(f"Finetuned LM for predictor {pred_ind} failed.") from finetuned_lm
            pred.lm = finetuned_lm
            # TODO: What should the correct behavior be here? Should
            # BootstrapFinetune modify the prompt demos according to the
            # train data?
            pred.demos = [] if self.exclude_demos else pred.demos

        logger.info("BootstrapFinetune has finished compiling the student program")
        student._compiled = True
        return student
```

需要说明的是：这里每个predictor都是基于从trace里提取出的微调数据进行独立微调，而不是所有predictor在流程中微调

即对每个predictor微调它在流程中所需的对应能力。

  

### `**rondom_search.py**`

`**BootstrapFewShotWithRandomSearch**`：在 **BootstrapFewShot** 思路上加 **随机搜索**（如对超参/流程的多轮尝试）。

它的核心思想是：

> 不只构造一套 few-shot demos，
> 
> 而是：
> 
> - 生成很多候选 demo 组合（candidate programs）
> 
> - 每套都评估
> 
> - 最后选效果最好的 program

本质上它是：

```
随机搜索 Few-shot 示例组合
        ↓
对每种组合编译 program
        ↓
在验证集评估
        ↓
选择最高分 program
```

```
重复很多次：
    shuffle trainset
    随机选 bootstrap size
    bootstrap demos
    compile program
    evaluate

最后：
    选择最佳 program
```

  

### `**telepromot_optuna.py**`

BootstrapFewShotWithRandomSearch的更高级版本

区别是：

```
RandomSearch:
    随机乱试

Optuna:
    贝叶斯优化 / 智能超参搜索
```

它本质上是在做：

```
Few-shot Demo Selection Optimization
```

但：

```
RandomSearch:
    随机选 demos

Optuna:
    用历史结果指导下一轮选择
```

```python
def _import_optuna():
    try:
        import optuna
    except ModuleNotFoundError as exc:
        if exc.name == "optuna":
            raise ImportError(
                "BootstrapFewShotWithOptuna requires optional dependency 'optuna'. "
                "Install it with `pip install dspy[optuna]`."
            ) from exc
        raise
    return optuna
```

```python
    def compile(self, student, *, teacher=None, max_demos, trainset, valset=None):
        optuna = _import_optuna()
        self.trainset = trainset
        self.valset = valset or trainset
        self.student = student.reset_copy()
        self.teacher = teacher.deepcopy() if teacher is not None else student.reset_copy()
        teleprompter_optimize = BootstrapFewShot(
            metric=self.metric,
            max_bootstrapped_demos=max_demos,
            max_labeled_demos=self.max_labeled_demos,
            teacher_settings=self.teacher_settings,
            max_rounds=self.max_rounds,
        )
        self.compiled_teleprompter = teleprompter_optimize.compile(
            self.student, teacher=self.teacher, trainset=self.trainset,
        )
        study = optuna.create_study(direction="maximize")
        study.optimize(self.objective, n_trials=self.num_candidate_sets)
        best_program = study.trials[study.best_trial.number].user_attrs["program"]
        print("Best score:", study.best_value)
        print("Best program:", best_program)
        return best_program
```

#### Optimization Problem：

设：

```
P = 一个 DSPy program
```

Program 中有：

```
多个 predictors
```

例如：

```
P1
P2
P3
```

每个 predictor：

```
都有多个 candidate demos
```

例如：

```
P1:
    d11 d12 d13

P2:
    d21 d22 d23

P3:
    d31 d32
```

---

搜索目标是寻找：

```
最佳 demo assignment
```

即：

```
argmax score(P(demos))
```

其中：

```
demos =  每个 predictor 选择的 demo
```

#### Optuna 是：

```
Hyperparameter Optimization Library
```

支持：

```
Bayesian Optimization
TPE
Adaptive Sampling
Pruning
```

包里搜索时空复杂度高，因此使用optuna算法来优化

  

### `**knn_fewshot.py**`

`**KNNFewShot**`：用 **嵌入相似度**从训练集挑近邻示例，当作 **demos** 喂给 predictor（向量检索式 few-shot）。

````python
"""
KNNFewShot 是一种优化器（optimizer），
它会在测试阶段（test time）使用内存中的 KNN（K 最近邻）检索器，
从训练集（trainset）中找到最相近的 k 个样本。

对于每一次 forward 调用中的输入样本，
它都会：
1. 从 trainset 中找到最相似的 k 个示例
2. 将这些示例作为 demonstrations（Few-shot 示例）
   附加到 student module 上

参数：
    k:
        要附加到 student model 上的最近邻示例数量。

    trainset:
        用于 few-shot prompting 的训练集。

    vectorizer:
        用于向量化的 `Embedder`。

    **few_shot_bootstrap_args:
        传递给 `BootstrapFewShot` 优化器的额外参数。

示例：

```python
import dspy
from sentence_transformers import SentenceTransformer

# 定义一个带 Chain-of-Thought 的 QA 模块
qa = dspy.ChainOfThought("question -> answer")

# 创建训练数据集
trainset = [
    dspy.Example(
        question="What is the capital of France?",
        answer="Paris"
    ).with_inputs("question"),

    # ... 更多示例 ...
]

# 使用 sentence-transformer 初始化 KNNFewShot
knn_few_shot = KNNFewShot(
    k=3,
    trainset=trainset,

    vectorizer=dspy.Embedder(
        SentenceTransformer(
            "all-MiniLM-L6-v2"
        ).encode
    )
)

# 使用 few-shot learning 编译 QA 模块
compiled_qa = knn_few_shot.compile(qa)

# 调用编译后的模块
result = compiled_qa(
    "What is the capital of Belgium?"
)
"""
````

这里有种RAG的感觉

前面的fewshot是静态的 demo，而KNNFewShot是动态的demo

不同输入动态检索不同 few-shot examples

  

### `**mipro_optimizer_v2.py**`

`**MIPROv2**`：**多候选指令 + few-shot**，配合 **GroundedProposer**、`Evaluate`、`optuna` 等做较大预算的指令/演示联合搜索。

它不是简单 few-shot。

而是：

```
Instruction Optimization
        +
Few-shot Optimization
        +
Bayesian Search
        +
Program-aware Prompt Generation
        +
Minibatch Evaluation
```

本质已经非常接近：LLM Program AutoML了。

全流程如下：

```
Step 1:
    Bootstrap few-shot demo candidates

Step 2:
    Propose instruction candidates

Step 3:
    Bayesian Optimization
        jointly search:
            instruction
            demos

Step 4:
    Evaluate programs

Step 5:
    Return best prompt program
```

```python
MIPROv2 整体流程：

输入：
    DSPy program
    trainset
    metric

==================================================
Step 1：生成 Few-shot Demo Candidates
==================================================

目标：
    不只使用一套 few-shot examples，
    而是生成很多 candidate demo sets。

方法：

    create_n_fewshot_demo_sets()

内部流程：

    多次运行 BootstrapFewShot

每次：

    1. 随机采样 trainset
    2. teacher 执行任务
    3. 生成 reasoning traces
    4. metric 筛选高质量 trace
    5. 构造成 augmented demos

最终得到：

    predictor_1:
        demo_set_1
        demo_set_2
        demo_set_3
        ...

    predictor_2:
        ...

注意：

    demos 不是普通 QA pair

而是：

    reasoning demonstrations

例如：

    question
    chain_of_thought
    tool_calls
    answer

==================================================
Step 2：生成 Instruction Candidates
==================================================

核心组件：

    GroundedProposer

本质：

    用 LLM 自动生成 prompts

即：

    meta-prompting

--------------------------------------------------
2.1 Dataset-aware
--------------------------------------------------

create_dataset_summary()

LLM 阅读 trainset：

    总结任务类型
    数据分布
    推理模式

例如：

    这是数学推理任务
    需要 step-by-step reasoning

--------------------------------------------------
2.2 Program-aware
--------------------------------------------------

get_dspy_source_code(program)

提取 DSPy program source code。

然后：

    DescribeProgram

分析：

    程序在做什么
    pipeline 如何工作

--------------------------------------------------
2.3 Module-aware
--------------------------------------------------

DescribeModule

分析：

    当前 predictor 的职责

例如：

    retrieval module
    reasoning module
    answer module

--------------------------------------------------
2.4 Fewshot-aware
--------------------------------------------------

从 successful demo traces 中：

    抽 reasoning examples

构造：

    task_demos

--------------------------------------------------
2.5 History-aware
--------------------------------------------------

previous_instructions

利用：

    历史 instruction
    历史 score

--------------------------------------------------
2.6 Tip-aware
--------------------------------------------------

随机加入 prompting heuristics：

    "Reason step-by-step"
    "Be concise"
    "Use a persona"
    "High-stakes scenario"

==================================================
Step 3：Instruction Synthesis
==================================================

GenerateSingleModuleInstruction

输入：

    dataset_description
    program_code
    module_description
    task_demos
    previous_instructions
    tip
    basic_instruction

让 LLM 生成：

    proposed_instruction

本质：

    Prompting the LM
    to create prompts
    for another LM

即：

    Prompt Synthesis

==================================================
Step 4：构造搜索空间
==================================================

每个 predictor：

拥有：

    instruction candidates:
        I1 I2 I3 ...

    demo candidates:
        D1 D2 D3 ...

形成搜索空间：

    (instruction, demos)

例如：

    Predictor1:
        (I2, D5)

    Predictor2:
        (I1, D3)

==================================================
Step 5：Bayesian Optimization
==================================================

使用：

    Optuna + TPE Sampler

搜索：

    最优 instruction × demos 组合

每次 trial：

    1. 采样 instruction index
    2. 采样 demo index
    3. 构造 candidate program
    4. Evaluate(program)
    5. 更新 Bayesian posterior

==================================================
Step 6：Minibatch Optimization
==================================================

问题：

    full validation 太昂贵

解决：

    minibatch eval

流程：

    小 batch 快速筛选
    周期性 full evaluation

本质：

    Multi-fidelity Optimization

类似：

    Hyperband
    Successive Halving

==================================================
Step 7：返回最佳 Program
==================================================

输出：

    最优 DSPy program

包括：

    optimized instructions
    optimized few-shot demos
    optimized reasoning traces

==================================================
MIPROv2 的真正本质
==================================================

MIPROv2 不只是：

    prompt tuning

而是：

    automatic LM program synthesis

即：

    自动生成 prompts
    自动生成 reasoning demos
    自动搜索 program configuration
    自动优化 LM pipeline

==================================================
一句话总结
==================================================

MIPROv2：

    先 bootstrap 高质量 reasoning demos，
    再利用任务数据、程序结构、模块职责和历史信息，
    自动生成 instruction candidates，
    最后通过贝叶斯优化联合搜索：
        instruction × demos
    从而找到最优 DSPy LM program。
```

  

### `**copro_optimizer.py**`

`**COPRO**`：**协作式指令优化**：多轮生成/改写 **instructions**（及有关 signature 文本），用 metric 迭代改进。

COPRO（Collaborative Prompt Optimization）本质上是：

```
“让一个LM不断改写Prompt，
然后用任务分数评估Prompt，
再把历史Prompt+分数反馈给LM继续进化。”
```

它是：

```
Prompt Evolution / Iterative Prompt Search
```

它优化的是 Predictor.signature 的 signature.instructions 和 output field prefix

举例如下

原始：

```
Answer the question.
```

优化后：

```
You are a careful scientific reasoning assistant.
Solve step-by-step and verify the final answer.
```

原输出prefix：

```
Answer:
```

优化后：

```
Final Verified Answer:
```

COPRO流程：

```
初始Prompt
    ↓
LM生成多个Prompt候选
    ↓
Evaluate打分
    ↓
保留高分Prompt
    ↓
把“历史Prompt+得分”喂给LM
    ↓
LM继续生成下一代Prompt
    ↓
继续评估
    ↓
迭代depth轮
    ↓
返回最优Prompt
```

本质：

```
LLM生成Prompt
+
任务Metric负责筛选
```

  

### `**infer_rules.py**`

`**InferRules**`（extends BootstrapFewShot）、`**RulesInductionProgram**`：从数据/workflow 里 **归纳规则类中间表示**，再走 bootstrap/规则程序（面向「规则+LM」流水线）。

它继承自 BootstrapFewShot

但它不是只做 few-shot demo bootstrap，而是在 bootstrap 完成后：

1. 从训练样本里“归纳规则”

1. 把规则拼接进 instruction

1. 多次随机生成不同规则候选

1. 在验证集上评估

1. 选最优 program

本质上：

> 它是在自动做 “prompt rule induction（规则归纳）”。

有点像：

- 自动 prompt engineering

- 自动总结 task heuristics

- 自动生成 instruction tuning 风格规则

  

### `**simba.py**`

`**SIMBA**`：**SIMBA** 优化策略实现（与其它 teleprompt 并列的一种搜索/改进 student 的方案）。

它不再只是“搜 prompt”

而是：

```
观察自己在哪些样本上行为差异大
    ↓
分析为什么成功/失败
    ↓
生成规则或demo
    ↓
再次评估
    ↓
保留优秀程序
```

本质已经很接近 Reflection Agent

SIMBA 的核心 insight：

一个样本如果不同 rollout 表现差异很大：

```
有时成功
有时失败
```

说明这个样本包含“可学习信息”

因为：

```
模型其实“有能力做对”
只是prompt/program不稳定
```

所以SIMBA 专门挑高 variance examples 做反思优化。

这是整个算法灵魂。

```
SIMBA 的核心流程：

1. 从当前已有 program 池中，随机采样一些 program
2. 对同一个 example 做多次 rollout
3. 观察哪些 example 上结果差异很大

例如：

同一个问题：

Program A → 0.95
Program B → 0.90
Program C → 0.15
Program D → 0.05

说明：

这个样本“有时能做对，有时做错”。

SIMBA 认为：

这种高方差样本最有学习价值。

因为：

模型能力其实已经存在，
只是 prompt/program 没有稳定激活它。

--------------------------------------------------

接下来进入 introspection：

SIMBA 会收集：

- 成功 trajectory
- 失败 trajectory
- prediction
- reasoning
- score

然后让 LLM 分析：

“为什么成功？”
“为什么失败？”
“应该遵循什么规则？”

--------------------------------------------------

之后生成两类改进：

1. append_a_rule

生成自然语言规则：

例如：

- 保留原始单位
- 不要引入额外假设
- 优先使用 context 中的措辞

然后：

把规则追加到 instruction：

原来：

Answer the question.

变成：

Answer the question.

Rules:
1. ...
2. ...

--------------------------------------------------

2. append_a_demo

从高分 trajectory 中提取成功 example：

input → output

然后加入 few-shot demos：

相当于：

“以后参考这个成功案例。”

--------------------------------------------------

然后构造新 candidate program：

candidate
=
旧 program 的 deepcopy
+
新 rule/demo
-
随机删除部分旧 demos

这里随机删除 demos：

是为了：

- 防止 prompt 无限增长
- 删除无效 demo
- 搜索更优 prompt 结构

--------------------------------------------------

最终得到：

新的 candidate prompt program。

然后：

SIMBA 会在 mini-batch 上重新评估这些 candidate。

高分 candidate：

保留进入 program pool。

低分 candidate：

淘汰。

--------------------------------------------------

整个过程本质：

program pool
    ↓
trajectory sampling
    ↓
高方差样本挖掘
    ↓
LLM 自我反思
    ↓
生成 rule/demo
    ↓
prompt mutation
    ↓
评估与选择
    ↓
形成更强 program

--------------------------------------------------

SIMBA 的核心思想：

不是：

“模型完全不会”

而是：

“模型偶尔已经会了，
但程序还无法稳定激活这种能力。”

所以：

通过 reflection + successful trajectory reuse，
逐渐把“偶尔成功”
变成
“稳定成功”。
```

  

### `**simba_utils.py**`

这是SIMBA 的核心“大脑”，里面实现了：

1. trajectory sampling 的 rollout 机制

1. trajectory tracing

1. successful trajectory → demo

1. successful vs failed trajectory → reflection rule

1. module introspection

可以说：

```
SIMBA.compile()
    ↓
调用 simba_utils
    ↓
真正完成 self-improvement
```

  

### `**better_together.py**`

`**BetterTogether**`：**联合优化**多个组件或阶段的 teleprompt（把多种信号/模块一起变好）。

这个 `BetterTogether` 本质上是：

> 一个“优化器调度器（meta-optimizer）”

它不直接优化 prompt 或 finetune。

而是：

- 把多个 Teleprompter 组合起来

- 按顺序串联执行

- 每一步后评估效果

最终得到：

> “prompt优化 + finetune + prompt优化 + ...” 的联合优化系统。

它本质上像：

```
Pipeline Scheduler
```

核心思想：Prompt优化和Weight优化是互补的

因此：

```
Prompt优化 → 找策略
Finetune → 固化策略
再Prompt优化 → 在更强模型上继续搜索
```

形成循环增强。

### `**avater_optimizer.py**`

`**AvatarOptimizer**`：面向 **Avatar** 场景的优化（比较器、`FeedbackBasedInstruction` 等 Signature，用 LM 反馈改指令/program）。

专门优化：

```
Tool-Using Agent
```

尤其是：

```
Avatar Agent
```

即：

```
LLM + Tools + Actions
```

它优化的不是：

- few-shot demos

- CoT

- finetune weights

而是：

```
工具使用 instruction
```

本质：

```
让 Agent 学会：
什么时候调用什么工具
怎么调用
调用顺序
失败时怎么办
```

这是：

```
Instruction Evolution for Tool Agents
```

compile流程：

```
for iteration:
    1. 在 trainset 跑 actor
    2. metric 打分
    3. 分离 正例/负例
    4. LLM 比较分析
    5. 生成 feedback
    6. LLM 重写 instruction
    7. 更新 actor
```

这是：

```
closed-loop instruction refinement
```

优化核心是：

```
best_actor.actor.signature.instructions
```

即：

```
Agent 的 system prompt
```

例如原始 instruction：

```
Use tools to answer user questions.
```

优化后可能变成：

```
When numerical computation is needed,
always call calculator first before reasoning.

When web evidence conflicts,
prioritize recent sources.

If retrieval returns empty,
retry with broader query.
```

即：

```
Tool-use policy learning
```

  

### `**grpo.py**`

`**GRPO**`：**继承** `**FinetuneTeleprompter**`，引入 **GRPO** 风格的训练/对齐逻辑（更重「策略/奖励」的一条线，与纯改 demos 不同）。  

## `**teleprompt/gepa/**`

它做了三件核心事情：

1. 把 DSPy Program 转成 GEPA 可优化对象

1. 捕获 DSPy 执行 trace 并生成 reflective feedback

1. 用 reflection LM 自动进化 predictor instruction

你现在读到的，其实已经不是普通 Prompt Optimization，而是：

> “带轨迹、带局部反馈、带反思、带进化搜索”的 Agentic Prompt Evolution System。

## `**evaluate/**`

`**Evaluate**` 与 `**metrics**`：和上面 `metric`、选优怎样闭合。