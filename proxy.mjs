// Project naming and addresses for the pure Vercel proxy.
//
// The project is created through Vercel's API with the files in
// vercel-proxy/ — no Git repository is cloned.

import { randomBytes } from "node:crypto"

export function randomSuffix(bytes = 4) {
  return randomBytes(bytes).toString("hex")
}

export function projectName() {
  // Vercel 的 <project>.vercel.app 子域名最多 35 个字符：kilo-proxy- + 24 hex = 35。
  // 24 hex = 96 bit 随机，足够不可猜。
  return "kilo-proxy-" + randomSuffix(12)
}

export function originOf(name) {
  return `https://${name}.vercel.app`
}

export function proxyBaseURL(name) {
  // vercel.json 只把域名反代到 Kilo，路径原样跟随；/api/v1 由插件这边带上。
  return `${originOf(name)}/api/v1`
}
