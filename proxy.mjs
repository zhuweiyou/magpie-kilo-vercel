// Building the Vercel clone URL for a pure proxy project, and the URLs.
//
// The Vercel project contains no application code: only static configuration
// that rewrites every request to Kilo's API. So the project never needs a
// redeploy when the plugin changes; only this repo's plugin does.

import { randomBytes } from "node:crypto"

export const REPOSITORY_URL = "https://github.com/zhuweiyou/magpie-kilo-vercel"
export const PROXY_SUBDIR = "vercel-proxy"
export const KILO_HOST = "ai-gateway.kilo.ai"

export function randomSuffix(bytes = 4) {
  return randomBytes(bytes).toString("hex")
}

export function projectName() {
  // Vercel 的 <project>.vercel.app 子域名最多 35 个字符：kilo-proxy- + 24 hex = 35。
  // 24 hex = 96 bit 随机，足够不可猜。
  return "kilo-proxy-" + randomSuffix(12)
}

// The Vercel clone flow can deploy a subdirectory, named by the repository
// URL's /tree/<branch>/<dir> path (or root-directory), so the repository can
// hold both this plugin and the no-code proxy.
export function buildCloneURL(name) {
  const url = new URL("https://vercel.com/new/clone")
  url.searchParams.set("repository-url", `${REPOSITORY_URL}/tree/main/${PROXY_SUBDIR}`)
  url.searchParams.set("project-name", name)
  url.searchParams.set("repository-name", name)
  return url.toString()
}

export function originOf(name) {
  return `https://${name}.vercel.app`
}

export function proxyBaseURL(name) {
  // vercel.json 只把域名反代到 Kilo，路径原样跟随；/api/v1 由插件这边带上。
  return `${originOf(name)}/api/v1`
}
