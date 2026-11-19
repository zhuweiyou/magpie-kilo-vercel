import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import { buildCloneURL, originOf, projectName, proxyBaseURL } from "../proxy.mjs"
import { passes, table } from "../models.mjs"
import { KiloProxyVercelPlugin, _internal } from "../index.mjs"

test("clone URL deploys the vercel-proxy subdirectory", () => {
  const url = new URL(buildCloneURL("kilo-proxy-abcd1234"))
  assert.equal(url.origin, "https://vercel.com")
  assert.equal(url.pathname, "/new/clone")
  assert.match(url.searchParams.get("repository-url"), /\/tree\/main\/vercel-proxy$/)
  assert.equal(url.searchParams.get("project-name"), "kilo-proxy-abcd1234")
  assert.equal(url.searchParams.get("repository-name"), "kilo-proxy-abcd1234")
  assert.equal(url.searchParams.get("env"), null)
})

test("generated projects and origins", () => {
  assert.match(projectName(), /^kilo-proxy-[0-9a-f]{24}$/)
  assert.equal(originOf("kilo-proxy-abcd1234"), "https://kilo-proxy-abcd1234.vercel.app")
  assert.equal(proxyBaseURL("kilo-proxy-abcd1234"), "https://kilo-proxy-abcd1234.vercel.app/api/v1")
})

test("stateOf derives the proxy base URL", () => {
  const state = _internal.stateOf({ type: "oauth", access: "anonymous", accountId: "kilo-proxy-abcd1234" })
  assert.equal(state.project, "kilo-proxy-abcd1234")
  assert.equal(state.baseURL, "https://kilo-proxy-abcd1234.vercel.app/api/v1")
  assert.equal(state.key, "anonymous")
})

test("free filtering follows isFree then the id rules", () => {
  assert.equal(passes("kilo-auto/free"), true)
  assert.equal(passes("x/y:free"), true)
  assert.equal(passes("nvidia/nemotron-3-ultra-550b-a55b:free"), true)
  assert.equal(passes("paid/model"), false)
  assert.equal(passes("paid/model", { isFree: false }), false)
  assert.equal(passes("paid/model", { isFree: true }), true)
  const models = table([
    "kilo-auto/free",
    { id: "nvidia/x:free", context: 1_000_000, output: 65_536, image: true },
  ])
  assert.ok(models["kilo-auto/free"])
  assert.equal(models["nvidia/x:free"].limit.context, 1_000_000)
  assert.equal(models["nvidia/x:free"].capabilities.attachment, true)
})

test("vercel.json is a fixed Kilo reverse proxy", async () => {
  const raw = await readFile(new URL("../vercel-proxy/vercel.json", import.meta.url), "utf8")
  const config = JSON.parse(raw)
  assert.equal(config.rewrites.length, 1)
  assert.equal(config.rewrites[0].source, "/(.*)")
  assert.equal(config.rewrites[0].destination, "https://ai-gateway.kilo.ai/$1")
})

test("config declares an OpenAI-compatible provider without a hardcoded catalogue", async () => {
  const plugin = await KiloProxyVercelPlugin({})
  const config = {}
  await plugin.config(config)
  assert.equal(config.provider["kilo-vercel"].npm, "@ai-sdk/openai-compatible")
  assert.equal(Object.keys(config.provider["kilo-vercel"].models).length, 0)
})

test("per-account concurrency is unlimited by default and follows maxInflight", async () => {
  const byDefault = await KiloProxyVercelPlugin({})
  assert.equal(byDefault.auth.maxConcurrency, undefined)
  const configured = await KiloProxyVercelPlugin({}, { maxInflight: 2 })
  assert.equal(configured.auth.maxConcurrency, 2)
})

test("loader points at the proxy and injects Kilo headers", async () => {
  const plugin = await KiloProxyVercelPlugin({})
  const loaded = await plugin.auth.loader(async () => ({
    type: "oauth",
    access: "anonymous",
    accountId: "kilo-proxy-abcd1234",
  }))
  assert.equal(loaded.baseURL, "https://kilo-proxy-abcd1234.vercel.app/api/v1")
  assert.equal(loaded.apiKey, "anonymous")
  assert.equal(typeof loaded.fetch, "function")
})
