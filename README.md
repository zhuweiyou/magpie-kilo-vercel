# magpie-kilo-vercel

在 magpie 里通过 **纯 Vercel 反向代理** 使用 Kilo 的免费模型。

**一个账号 = 一个 `kilo-proxy-<24位随机>.vercel.app` 项目。** 这个 Vercel 项目里没有任何业务代码：

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "https://ai-gateway.kilo.ai/$1" }
  ]
}
```

也就是把整个站**完全反代**到 Kilo 域名，**路径原样跟随**（`/api/v1/...` 由插件那一侧拼上）。**Vercel 端永久不需要更新**：更新永远只发生在这个插件里。每个代理项目的出口 IP 不同，所以多个账号 = 多个出口，由 magpie 自己轮询/故障切换。

## 装

```bash
magpie plugin add github:zhuweiyou/magpie-kilo-vercel
```

## 添加账号

点 **Add a Kilo proxy node on Vercel**：

1. 打开 Vercel clone 页面；
2. 不需要填任何环境变量；如果页面分两步（先建 Git 仓库、再确认部署），请一直点到「部署完成」；
3. 插件轮询 `https://kilo-proxy-<随机>.vercel.app/api/v1/models`，就绪后自动完成添加。

再加一个账号就再点一次，得到另一个代理项目（另一个出口）。

## 为什么这样

- **Vercel 是纯代理，没有代码**：不需要构建、不需要更新；`vercel.json` 永不变。
- **插件直接用 OpenAI 兼容 SDK**：`@ai-sdk/openai-compatible` 指向代理根地址，协议/流式/工具调用都由 Kilo 和 SDK 完成，插件不写任何转换代码。
- **不需要 Vercel API/token**：不扫描、不创建项目（项目由 Vercel 自己的 clone 流程创建），插件只保存代理地址。
- **完全公开、无 key**：安全靠项目名不可猜（`kilo-proxy-` + 24 个 hex 字符，96 bit 随机；受 Vercel 35 字符域名上限约束）。
- **轮询交给 magpie**：多个账号由 magpie 的账号路由分配。

## 注意

- `vercel-proxy/vercel.json` 里把上游**写死**为 `ai-gateway.kilo.ai`，不是开放代理。
- `proxy.mjs` 的 `REPOSITORY_URL` 默认 `https://github.com/zhuweiyou/magpie-kilo-vercel`；换仓库改这里。
- **模型列表不写死**：直接读代理的 `/models`（Kilo `/api/v1/models`），按 `isFree`/`*:free` 过滤，并用上游给的 `context_length`、`max_completion_tokens`、`input_modalities` 填元数据。
- Kilo 上游不认 `auto` 模型名，请用 `/models` 里的真实 id（如 `kilo-auto/free`），插件模型列表就是从这里过滤出来的。
