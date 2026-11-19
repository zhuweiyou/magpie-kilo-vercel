// Vercel device sign-in and the two API calls this plugin needs: create a
// project and deploy the proxy folder to it as files. Nothing is cloned and no
// GitHub repository is made.

import { readFile } from "node:fs/promises"

const ISSUER = "https://vercel.com"
const CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp" // Vercel CLI's public client
const API = "https://api.vercel.com"
const UA = "magpie-kilo-vercel/0.1.0"

let discovery = null

async function endpoints() {
  if (discovery) return discovery
  const response = await fetch(ISSUER + "/.well-known/openid-configuration", {
    headers: { accept: "application/json", "user-agent": UA },
  })
  if (!response.ok) throw new Error(`Vercel sign-in discovery answered ${response.status}`)
  const document = await response.json()
  discovery = {
    device: document.device_authorization_endpoint,
    token: document.token_endpoint,
  }
  return discovery
}

const form = (value) => new URLSearchParams(value).toString()

function oauthError(json, status) {
  const code = String(json?.error ?? "")
  const why = String(json?.error_description ?? "")
  const error = new Error(code ? `${code}${why ? `: ${why}` : ""}` : `token endpoint answered ${status}`)
  error.code = code
  error.status = status
  return error
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error("the sign-in was cancelled"))
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })

// startDevice asks for the code the user types at vercel.com/login/device.
export async function startDevice() {
  const { device } = await endpoints()
  const response = await fetch(device, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: form({ client_id: CLIENT_ID, scope: "openid offline_access" }),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok || !json) throw oauthError(json, response.status)
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verify: String(json.verification_uri_complete || json.verification_uri || ""),
    expiresAt: Date.now() + (Number(json.expires_in) || 600) * 1000,
    interval: Math.max(1, Number(json.interval) || 5) * 1000,
  }
}

export async function pollDevice(device, { signal, onWait } = {}) {
  const { token } = await endpoints()
  let interval = device.interval
  while (Date.now() < device.expiresAt) {
    if (signal?.aborted) throw new Error("the sign-in was cancelled")
    await sleep(interval, signal)
    let response, json
    try {
      response = await fetch(token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: form({
          client_id: CLIENT_ID,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device.deviceCode,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      json = await response.json().catch(() => null)
    } catch (error) {
      if (signal?.aborted) throw new Error("the sign-in was cancelled")
      interval = Math.min(interval * 2, 15_000)
      onWait?.(error)
      continue
    }
    if (response.ok && typeof json?.access_token === "string") return json
    const error = oauthError(json, response.status)
    if (error.code === "authorization_pending") {
      onWait?.(error)
      continue
    }
    if (error.code === "slow_down") {
      interval += 5_000
      onWait?.(error)
      continue
    }
    throw error
  }
  throw new Error("Vercel's code ran out before the sign-in finished")
}

async function call(access, path, { method = "GET", body, query, signal } = {}) {
  const url = new URL(path, API)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
  }
  const headers = { authorization: `Bearer ${access}`, "user-agent": UA, accept: "application/json" }
  let payload
  if (body !== undefined) {
    headers["content-type"] = "application/json"
    payload = JSON.stringify(body)
  }
  const response = await fetch(url, { method, headers, body: payload, signal })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!response.ok) {
    const why = json?.error?.message || json?.message || json?.error || text.slice(0, 300)
    const error = new Error(`Vercel answered ${response.status}${why ? `: ${why}` : ""}`)
    error.status = response.status
    throw error
  }
  return json
}

export async function getUser(access, signal) {
  const payload = await call(access, "/v2/user", { signal })
  return payload?.user ?? {}
}

export async function ensureProject(access, name, signal) {
  try {
    const project = await call(access, `/v9/projects/${encodeURIComponent(name)}`, { signal })
    if (project?.id) return project
  } catch (error) {
    if (error.status !== 404) throw error
  }
  await call(access, "/v11/projects", { method: "POST", body: { name, framework: null }, signal })
  const project = await call(access, `/v9/projects/${encodeURIComponent(name)}`, { signal })
  if (!project?.id) throw new Error(`Vercel created ${name} but it cannot be read back`)
  return project
}

// API-created projects should not inherit the account's SSO deployment
// protection; try to clear it, and if this API rejects the field just continue.
export async function clearProtection(access, projectID, signal) {
  try {
    await call(access, `/v9/projects/${encodeURIComponent(projectID)}`, {
      method: "PATCH",
      body: { ssoProtection: null },
      signal,
    })
  } catch {}
}

// templateFiles reads the proxy configuration from this plugin's own folder.
export async function templateFiles() {
  const root = new URL("./vercel-proxy/", import.meta.url)
  const vercelJSON = await readFile(new URL("vercel.json", root), "utf8")
  const robots = await readFile(new URL("public/robots.txt", root), "utf8")
  return [
    { file: "vercel.json", data: vercelJSON },
    { file: "public/robots.txt", data: robots },
  ]
}

export async function deployFiles(access, project, files, { signal, timeoutMs = 20 * 60 * 1000 } = {}) {
  const created = await call(access, "/v13/deployments?forceNew=1", {
    method: "POST",
    signal,
    body: {
      name: project,
      project,
      target: "production",
      files,
      projectSettings: {
        buildCommand: null,
        outputDirectory: "public",
        framework: null,
      },
    },
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await call(access, `/v13/deployments/${encodeURIComponent(created.id)}`, { signal })
    if (current?.readyState === "READY") return current
    if (current?.readyState === "ERROR" || current?.readyState === "CANCELED") {
      throw new Error(`Vercel build ${current.readyState}: ${current.errorMessage ?? "unknown"}`)
    }
    await sleep(3000, signal)
  }
  throw new Error("waiting for the Vercel deployment timed out")
}
