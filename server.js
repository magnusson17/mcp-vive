import "dotenv/config"
import express from "express"
import { z } from "zod"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { randomUUID } from "node:crypto"

const PORT = process.env.PORT || 3000
const DRUPAL_JSONAPI_ENDPOINT = process.env.DRUPAL_JSONAPI_ENDPOINT

// Optional auth headers if Drupal is protected
// e.g. DRUPAL_BEARER_TOKEN="xxxxx"
const DRUPAL_BEARER_TOKEN = process.env.DRUPAL_BEARER_TOKEN || ""
const DRUPAL_TIMEOUT_MS = Number(process.env.DRUPAL_TIMEOUT_MS || 10000)

// In-memory session store (sessionId -> { transport, server })
const sessions = new Map()

async function fetchJson(url) {

    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), DRUPAL_TIMEOUT_MS)

    // Outer try ... finally: ensures clearTimeout(t) always runs,
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/vnd.api+json",
                ...(DRUPAL_BASIC_AUTH
                ? { Authorization: "Basic " + Buffer.from(DRUPAL_BASIC_AUTH).toString("base64") } : {})
            },
            signal: controller.signal
        })

        // converto prima in text() e solo poi faccio un parse in json
        // perché se ho un errore in await res.json() ho un throw prima di ottenere il body e quindi meno info
        const text = await res.text()
        let json = null

        try {
            json = text ? JSON.parse(text) : null
        } catch (e) {
            console.log(e)
        }

        return {
            ok: res.ok,
            status: res.status,
            json,
            text
        }
    } finally {
        clearTimeout(t)
    }
}

function stripHtml(html) {
    if (!html) return ""
    return String(html)
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
        .replace(/<\/?[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

// Resolve relationship(s) into readable names when included resources are present
function resolveIncludedNames(payload, relData) {
    if (!payload?.included || !relData) return null

    const included = payload.included

    const resolveOne = (ref) => {
        const found = included.find((x) => x.type === ref.type && x.id === ref.id)
        if (!found) return null
        // taxonomy terms usually have attributes.name
        // nodes have attributes.title
        return found.attributes?.name || found.attributes?.title || null
    }

    if (Array.isArray(relData)) {
        return relData.map(resolveOne).filter(Boolean)
    }

    return resolveOne(relData)
}

function buildOperaUrlWithFilterParams(numeroInventario) {

    const endpoint = new URL(DRUPAL_JSONAPI_ENDPOINT)
    endpoint.searchParams.set("page[limit]", "1")
    // es .../jsonapi/node/opera?filter[field_inventario]=10220
    endpoint.searchParams.set("filter[field_inventario]", String(numeroInventario))
    endpoint.searchParams.set(
        "include",
        [
            "field_autore",
            "field_tipologia",
            "field_luogo",
            "field_tecnica",
            "field_materiale",
            "field_schedatore"
        ].join(",")
    )

    return endpoint.toString()
}

// Fallback using verbose condition format (in case buildOperaUrlWithFilterParams is disabled)
function buildOperaUrlWithFilterParamsVerboseFallback(numeroInventario) {
    
    const u = new URL(DRUPAL_JSONAPI_ENDPOINT)
    u.searchParams.set("page[limit]", "1")

    u.searchParams.set("filter[inventario][condition][path]", "field_inventario")
    u.searchParams.set("filter[inventario][condition][operator]", "=")
    u.searchParams.set("filter[inventario][condition][value]", String(numeroInventario))

    u.searchParams.set(
        "include",
        [
            "field_autore",
            "field_tipologia",
            "field_luogo",
            "field_tecnica",
            "field_materiale",
            "field_schedatore"
        ].join(",")
    )

    return u.toString()
}

async function lookupOperaByInventario(numeroInventario) {
    
    // prima di fare il fetch devo costruire meglio l'url
    // partendo da DRUPAL_JSONAPI_ENDPOINT devo aggiungere tutti quei filtri che mi permettono di ottenere i valori delle relazioni (tassonomie, riferimenti...)
    const buildUrl = buildOperaUrlWithFilterParams(numeroInventario)
    let res = await fetchJson(buildUrl)

    // If Drupal rejects the shortcut filter format, retry with verbose format
    if (!res.ok && (res.status === 400 || res.status === 403)) {
        const verboseUrl = buildOperaUrlWithFilterParamsVerboseFallback(numeroInventario)
        res = await fetchJson(verboseUrl)
    }

    if (!res.ok) {
        return {
            found: false,
            error: `Drupal request failed (${res.status})`,
            details: res.json?.errors || res.text?.slice(0, 500) || null
        }
    }

    const payload = res.json
    const item = Array.isArray(payload?.data) ? payload.data[0] : payload?.data

    if (!item) {
        return {
            found: false,
            error: null
        }
    }

    const a = item.attributes || {}

    const autore = resolveIncludedNames(payload, item.relationships?.field_autore?.data)
    const tipologia = resolveIncludedNames(payload, item.relationships?.field_tipologia?.data)
    const luogo = resolveIncludedNames(payload, item.relationships?.field_luogo?.data)
    const tecnica = resolveIncludedNames(payload, item.relationships?.field_tecnica?.data)
    const materiale = resolveIncludedNames(payload, item.relationships?.field_materiale?.data)
    const schedatore = resolveIncludedNames(payload, item.relationships?.field_schedatore?.data)

    const descrizioneHtml = a.field_descrizione?.processed || a.field_descrizione?.value || ""
    const descrizioneText = stripHtml(descrizioneHtml)

    return {
        found: true,
        id: item.id,
        type: item.type,
        title: a.title || null,
        numero_inventario: a.field_inventario || null,
        periodo: a.field_periodo || null,
        data_label: a.field_data_label || null,
        data_da: a.field_data_0 ?? null,
        data_a: a.field_data_1 ?? null,
        acquisizione: a.field_acquisizione || null,
        dimensioni: {
            altezza: a.field_altezza ?? null,
            larghezza: a.field_larghezza ?? null,
            diametro: a.field_diametro ?? null,
            spessore: a.field_spessore ?? null
        },
        autore,
        tipologia,
        luogo,
        tecnica,
        materiale,
        schedatore,
        descrizione: {
            text: descrizioneText,
            html: descrizioneHtml
        },
        links: item.links || null
    }
}

function buildMcpServer() {

    const server = new McpServer({
        name: "vive-inventario-mcp",
        version: "1.0.0"
    })

    server.registerTool(

        "get_opera_by_inventario",

        {
            title: "Get item by inventario",
            description:
                "Given an inventory number (field_inventario / numero inventario), returns the corresponding Opera item from Drupal JSON:API.",
            inputSchema: {
                numero_inventario: z.string().min(1)
            },
            annotations: {
                readOnlyHint: true,
                openWorldHint: false,
                destructiveHint: false
            }
        },
        
        // numero_inventario è valorizzato dallo usere quando scrive il numero nella chat con l'agente
        async ({ numero_inventario }) => {
            const result = await lookupOperaByInventario(numero_inventario)

            if (!result.found) {
                return {
                    structuredContent: result,
                    content: [
                        {
                            type: "text",
                            text: result.error
                                ? `No item found or request failed for inventario ${numero_inventario}: ${result.error}`
                                : `No item found for inventario ${numero_inventario}`
                        }
                    ]
                }
            }

            return {
                structuredContent: result,
                content: [
                    {
                        type: "text",
                        text: `Found: ${result.title} (inventario ${result.numero_inventario})`
                    }
                ]
            }
        }
    )

    return server
}

// --- HTTP host (Render) ---
const app = express()
app.use(express.json({ limit: "1mb" }))

app.get("/health", (req, res) => {
    res.json({ ok: true })
})

// POST: client->server messages (initialize + tool calls)
app.post("/mcp", async (req, res) => {
    try {
        const sessionId = req.headers["mcp-session-id"]
        let session = sessionId ? sessions.get(sessionId) : null

        if (session) {
            await session.transport.handleRequest(req, res, req.body)
            return
        }

        // No session yet: must be an initialize request
        if (!sessionId && isInitializeRequest(req.body)) {
            const server = buildMcpServer()

            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                    sessions.set(newSessionId, { transport, server })
                }
            })

            transport.onclose = () => {
                if (transport.sessionId) sessions.delete(transport.sessionId)
                server.close()
            }

            await server.connect(transport)
            await transport.handleRequest(req, res, req.body)
            return
        }

        // Otherwise invalid
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null
        })
    } catch (err) {
        console.error(err)
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null
            })
        }
    }
})

// GET: server->client notifications via SSE (for session-based clients)
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"]
    const session = sessionId ? sessions.get(sessionId) : null

    if (!session) {
        res.status(400).send("Invalid or missing session ID")
        return
    }

    await session.transport.handleRequest(req, res)
})

// DELETE: end a session
app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"]
    const session = sessionId ? sessions.get(sessionId) : null

    if (!session) {
        res.status(400).send("Invalid or missing session ID")
        return
    }

    await session.transport.handleRequest(req, res)
})

app.listen(PORT, () => {
    console.log(`MCP server listening on http://localhost:${PORT}/mcp`)
})
