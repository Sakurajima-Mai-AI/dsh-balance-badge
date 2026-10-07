# dsh-balance-badge

**在 DSH 侧边栏实时显示 DeepSeek 账户余额，并在每次任务扣费时显示消耗金额。**

Real-time account balance for the DeepSeek Harness sidebar, with a running charge
readout for the work that spends it.

---

## 效果

侧边栏底部（用户头像正上方）就是这样一行：

```
🪙 ¥12.345  ·  赠送 ¥3.268                              -¥0.075
```

- 左边是**充值余额**与**赠送额度**（三位小数；赠送额度为 0 或不存在时整段自动隐去）
- 最右端是**最近一次任务的消耗**，红色显示；5 分钟内连续扣费会累加成一个总数
- 悬停查看余额、赠送额度、最近扣费、上次刷新时间

## 特性

| 特性 | 说明 |
|---|---|
| 余额常驻 | 每 2 秒读取一次；窗口重新聚焦时立即再读 |
| 扣费提示 | 任务消耗额度后出现在行尾；充值会自动清除它 |
| **全钱包监控** | 同时监视充值余额与赠送额度，任一下降都计入消耗 |
| 失败不空白 | 读取失败保留上次数值并加警示标记，不会把已知数字抹掉 |
| 零配置 | 装上即用，不需要 API Key，也不需要任何设置 |

## 安装

这是一个 DSH 插件包（`package.json` 里声明了 `dsh.bundle` 与 `dsh.client`）。
通过 DSH 的插件管理界面添加本仓库地址即可，例如：

```
https://github.com/Sakurajima-Mai-AI/dsh-balance-badge
```

本地开发时也可以直接指向克隆下来的目录：

```
git clone https://github.com/Sakurajima-Mai-AI/dsh-balance-badge
# 然后在 DSH 插件管理里填入克隆下来的目录路径
```

安装后需要重启 DSH：客户端 bundle 在启动时装配。

## 工作原理

数据全部来自 DSH 已经提供的账户 Remote，插件自己不接触任何凭据：

```
widget ──► ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })
             └─► accountController.getBalance()  ──► Platform
```

**扣费是推导出来的，不是平台直接给的。** DSH 不暴露「本次任务花了多少钱」，
`sessionStats` 只有 token 数与耗时。所以消耗金额取的是**两次连续读取之间的余额下降量**：

- 账户 Remote 是唯一权威来源，因此金额真实；
- 归属到「哪一次任务」是推断 —— 一次任务里多次扣费会累加成总数；
- 余额上升（充值）会清除提示，而不是显示成负消耗。

比较用的是**接口返回的原始字符串**，不是屏幕上那三位小数。这一点很关键：
一次任务常常只消耗万分之几元，用显示值做差会得到恒等于零的结果。

## 已知限制

- **提示会晚到。** 平台在任务结束后数秒才结算余额，插件只能在结算后的下一次读取里看到它。
  这是数据源延迟，加密轮询无法根治，所以本项目刻意保持 2 秒的固定间隔。
- **客户端没有 `timer` 服务。** `ctx.interval` 在本环境中不存在，调用它会让插件加载失败。
  因此计时一律使用浏览器原生定时器，并且必须**裸调用**（`setInterval(...)`），
  写成 `globalThis.setInterval(...)` 会导致轮询静默停摆。
- **没有价格表。** 插件不按 token 估算费用，因为那需要维护一份会过期的单价表，
  而余额差额本身就是精确答案。

## 开发

```bash
# 离线自检：不需要启动 DSH
node verify-balance.cjs /path/to/installed/plugin
```

自检覆盖 47 项，其中最关键的一条是 **`apply()` 必须不抛异常** ——
DSH 的启动审计把任何非 `active` 的插件视为致命错误，会直接拒绝启动整个界面。
脚本头部记录了本项目在这台客户端上踩过的全部运行时约束。

改动 `lib/client.js` 之后请先跑自检，再重启 DSH。

## License

[MIT](LICENSE)