// Models come from Kilo itself through the proxy: /models carries
// context_length, top_provider.max_completion_tokens and
// architecture.input_modalities, so nothing is hardcoded here. Only the free
// entries are kept (Kilo's isFree, or the :free / kilo-auto/free rules).

export function kiloHeaders() {
  return {
    accept: "application/json",
    "http-referer": "https://kilo.ai/",
    "x-title": "Kilo Code",
    "user-agent": "opencode-kilo-provider/7.0.0",
    "x-kilocode-editorname": "Kilo CLI 7.0.0",
  }
}

export function passes(id, entry) {
  if (entry && typeof entry.isFree === "boolean") return entry.isFree
  const value = String(id ?? "").toLowerCase()
  return value === "kilo-auto/free" || value === "openrouter/free" || value.endsWith(":free")
}

function detailsOf(entry) {
  if (typeof entry === "string") {
    return { id: entry, context: 200_000, output: 32_000, image: false }
  }
  return {
    id: String(entry?.id ?? ""),
    context: Number(entry?.context ?? 200_000) || 200_000,
    output: Number(entry?.output ?? 32_000) || 32_000,
    image: !!entry?.image,
  }
}

export function modelEntry(entry) {
  const detail = detailsOf(entry)
  return {
    id: detail.id,
    name: detail.id,
    api: { id: detail.id, npm: "@ai-sdk/openai-compatible" },
    limit: { context: detail.context, output: detail.output },
    capabilities: { reasoning: false, toolcall: true, attachment: detail.image },
    free: true,
    cost: { input: 0, output: 0 },
    release_date: "",
  }
}

// table builds the provider's model map from entries (or bare ids).
export function table(entries) {
  const out = {}
  for (const entry of entries) {
    const value = typeof entry === "string" ? entry : String(entry?.id ?? "")
    if (!value || out[value]) continue
    out[value] = modelEntry(entry)
  }
  return out
}

// read asks the proxy's /models, which reaches Kilo's /api/v1/models, and
// keeps the free entries with the metadata Kilo gives.
export async function read(baseURL, { timeoutMs = 8000 } = {}) {
  if (!baseURL) return null
  let response
  try {
    response = await fetch(`${baseURL}/models`, {
      headers: kiloHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }
  if (!response.ok) return null
  let payload
  try {
    payload = await response.json()
  } catch {
    return null
  }
  const data = Array.isArray(payload?.data) ? payload.data : []
  const entries = []
  for (const item of data) {
    const id = String(item?.id ?? "")
    if (!id || !passes(id, item)) continue
    const rawModalities = item?.architecture?.input_modalities
    const modalities = Array.isArray(rawModalities) ? rawModalities : []
    entries.push({
      id,
      context: Number(item?.context_length ?? item?.top_provider?.context_length) || 200_000,
      output: Number(item?.top_provider?.max_completion_tokens) || 32_000,
      image: modalities.includes("image"),
    })
  }
  return entries.length ? entries : null
}
