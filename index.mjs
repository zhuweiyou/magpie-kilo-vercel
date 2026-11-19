// kilo through a pure Vercel reverse proxy, as an OpenCode provider plugin for
// magpie.
//
// One magpie account is one Vercel project named kilo-proxy-<random>. That
// project has no application code; its static configuration rewrites every
// request to Kilo's OpenAI-compatible API. The plugin itself speaks OpenAI
// (baseURL + apiKey) and talks through the proxy, so the Vercel side never has
// to be redeployed when the plugin changes.
//
// Clicking "Add account" signs in to Vercel once (device code), then the plugin
// creates the project through Vercel's API and uploads the proxy files itself:
// no Git repository, no clone, nothing to fill in. magpie's own account routing
// then spreads requests over all the proxies, each with its own egress IP.

import { originOf, projectName, proxyBaseURL } from "./proxy.mjs"
import * as models from "./models.mjs"
import * as vercel from "./vercel.mjs"

const PROVIDER = "kilo-vercel"

function stateOf(auth) {
  if (!auth || typeof auth !== "object") return null
  if (auth.type !== "oauth" && !auth.access) return null
  const project = String(auth.accountId || auth.projectName || auth.username || "")
  const baseURL = String(auth.baseURL || (project ? proxyBaseURL(project) : ""))
  return { project, baseURL, key: String(auth.access || "anonymous") }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function abortError(signal) {
  const error = new Error("aborted")
  error.name = "AbortError"
  return error
}

// One in-memory gate per proxy account. A permit is held until the response
// body is fully read or cancelled, so a streaming answer counts as in-flight
// for its whole life. Nothing is persisted.
function createGate(limit) {
  let active = 0
  const waiters = []
  const grant = () => {
    active += 1
    let held = true
    return () => {
      if (!held) return
      held = false
      active -= 1
      while (active < limit && waiters.length > 0) waiters.shift()()
    }
  }
  return {
    get active() {
      return active
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal))
      if (active < limit) return Promise.resolve(grant())
      return new Promise((resolve, reject) => {
        const waiter = () => resolve(grant())
        waiters.push(waiter)
        signal?.addEventListener(
          "abort",
          () => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(abortError(signal))
          },
          { once: true },
        )
      })
    },
  }
}

async function waitForProxy(project, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const origin = originOf(project)
  const base = proxyBaseURL(project)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/models`, {
        headers: models.kiloHeaders(),
        signal: AbortSignal.timeout(8000),
      })
      if (response.ok) {
        const payload = await response.json().catch(() => null)
        if (payload && Array.isArray(payload.data)) return { ok: true, origin }
      }
    } catch {}
    await sleep(3000)
  }
  return { ok: false, origin, reason: `等待 ${base}/models 就绪超时` }
}

export async function KiloProxyVercelPlugin({ client: magpie } = {}, options = {}) {
  const maxInflight =
    Number.isInteger(options?.maxInflight) && options.maxInflight > 0 ? options.maxInflight : 0
  const gates = new Map()
  const gateFor = (key) => {
    let gate = gates.get(key)
    if (!gate) {
      gate = createGate(maxInflight)
      gates.set(key, gate)
    }
    return gate
  }
  const log = (message, level = "info") => {
    try {
      magpie?.app?.log?.({ body: { service: PROVIDER, level, message } })
    } catch {}
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Kilo Vercel",
        npm: "@ai-sdk/openai-compatible",
        ...was,
        // No hardcoded catalogue: the provider's models are read from the
        // proxy's /models once an account exists.
        models: { ...(was.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth: saved } = {}) {
        const state = stateOf(saved)
        if (!state) return provider.models
        const ids = await models.read(state.baseURL)
        if (!ids) {
          const fallback = { ...provider.models }
          fallback[Symbol.for("magpie.fellBack")] = true
          return fallback
        }
        return models.table(ids)
      },
    },

    auth: {
      provider: PROVIDER,
      // 默认不限制；只有明确设置 maxInflight 才给该账号排队。
      maxConcurrency: maxInflight > 0 ? maxInflight : undefined,
      refreshLead: 10 * 60 * 1000,
      methods: [
        {
          type: "oauth",
          label: "Add a Kilo Vercel proxy node",
          async authorize() {
            const device = await vercel.startDevice()
            const project = projectName()
            return {
              url: device.verify,
              instructions:
                `在浏览器完成 Vercel 授权（设备码：${device.userCode}）。\n` +
                `授权后插件会自动创建代理项目 ${project} 并部署，不需要填任何东西。`,
              method: "auto",
              async callback() {
                try {
                  log(`Vercel sign-in finished, creating ${project}`)
                  const token = await vercel.pollDevice(device)
                  const created = await vercel.ensureProject(token.access_token, project)
                  await vercel.clearProtection(token.access_token, created.id)
                  const files = await vercel.templateFiles()
                  log(`deploying ${project}`)
                  await vercel.deployFiles(token.access_token, project, files, {
                    timeoutMs: 15 * 60 * 1000,
                  })
                  const ready = await waitForProxy(project)
                  if (!ready.ok) return { type: "failed", error: ready.reason || "proxy did not become ready" }
                  return {
                    type: "success",
                    access: "anonymous",
                    accountId: project,
                    username: project,
                    projectName: project,
                  }
                } catch (error) {
                  return { type: "failed", error: String(error?.message || error) }
                }
              },
            }
          },
        },
      ],

      async refresh() {
        return {}
      },

      async loader(getAuth) {
        const state = stateOf(await getAuth())
        if (!state || !state.baseURL) return {}
        const kilo = models.kiloHeaders()
        const gate = maxInflight > 0 ? gateFor(state.baseURL) : null
        return {
          baseURL: state.baseURL,
          apiKey: "anonymous",
          async fetch(input, init = {}) {
            const headers = new Headers(init.headers ?? {})
            for (const [key, value] of Object.entries(kilo)) {
              if (!headers.has(key)) headers.set(key, value)
            }
            headers.set("authorization", "Bearer anonymous")

            if (!gate) return fetch(input, { ...init, headers })

            const release = await gate.acquire(init.signal)
            let response
            try {
              response = await fetch(input, { ...init, headers })
            } catch (error) {
              release()
              throw error
            }
            if (!response.body) {
              release()
              return response
            }
            const reader = response.body.getReader()
            let released = false
            const finish = () => {
              if (released) return
              released = true
              release()
            }
            const body = new ReadableStream({
              async pull(controller) {
                try {
                  const { done, value } = await reader.read()
                  if (done) {
                    finish()
                    controller.close()
                    return
                  }
                  controller.enqueue(value)
                } catch (error) {
                  finish()
                  controller.error(error)
                }
              },
              async cancel(reason) {
                finish()
                try {
                  await reader.cancel(reason)
                } catch {}
              },
            })
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          },
        }
      },

      async usage(getAuth) {
        const state = stateOf(await getAuth())
        if (!state) return { windows: [] }
        return {
          plan: "Vercel proxy",
          user: state.project,
          windows: [{ name: state.project, used: 0, display: state.baseURL, span: 0 }],
        }
      },
    },
  }
}

export const _internal = { stateOf, PROVIDER, waitForProxy }
