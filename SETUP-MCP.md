# Multi-Agent Debate — MCP Server

Un MCP server que permite que **múltiples IAs** (Claude Desktop, Cursor, cualquier cliente MCP) se conecten a un debate compartido y charlen en simultáneo.

---

## Instalación

```bash
cd multi-agent-chat
npm install
```

## Dos modos de conexión

### Modo 1: STDIO (para Claude Desktop / Cursor config)

```bash
node mcp-server.js
```

No tiene URL — cada cliente lanza su propia instancia. El estado se comparte via `debates.json`.

### Modo 2: HTTP/SSE (URL compartida)

```bash
node mcp-server.js --http 3000
```

**URLs del server:**

| Endpoint | URL | Para qué |
|---|---|---|
| Info | `http://localhost:3000/` | Health check, estado general |
| SSE | `http://localhost:3000/sse` | Conexión MCP (canal persistente) |
| Messages | `http://localhost:3000/messages` | Envío de mensajes MCP |

Puerto custom: `node mcp-server.js --http 8080`

---

## Configurar en Claude Desktop (stdio)

1. Abre Claude Desktop → Settings → Developer → Edit Config
2. Agrega en `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "multi-agent-debate": {
      "command": "node",
      "args": ["C:\\RUTA\\A\\TU\\multi-agent-chat\\mcp-server.js"]
    }
  }
}
```

3. Reinicia Claude Desktop

## Configurar en Cursor (stdio)

En `.cursor/mcp.json` del proyecto:

```json
{
  "mcpServers": {
    "multi-agent-debate": {
      "command": "node",
      "args": ["C:\\RUTA\\A\\TU\\multi-agent-chat\\mcp-server.js"]
    }
  }
}
```

## Configurar cualquier MCP client via URL (SSE)

1. Arranca el server: `node mcp-server.js --http 3000`
2. En el cliente MCP, apunta a: `http://localhost:3000/sse`
3. El cliente se conecta por SSE y puede usar todas las tools

---

## Herramientas disponibles

| Tool | Qué hace |
|---|---|
| `iniciar_debate` | Crea un debate nuevo con un tema |
| `unirse` | Te unes al debate con un nombre |
| `decir` | Dices algo (visible para todos) |
| `leer` | Lees el historial completo o solo lo nuevo |
| `avanzar_ronda` | Pasa a la siguiente ronda |
| `finalizar` | Cierra el debate con síntesis |
| `debates` | Lista todos los debates |
| `estado` | Estado del debate activo |

## Ejemplo de uso

Desde Claude Desktop:

> "Inicia un debate sobre cómo mejorar el onboarding de usuarios"

Desde Cursor (conectado al mismo server):

> "Únete al debate-001 como cursor-ai y da tu perspectiva técnica"

Desde otro Claude Desktop:

> "Lee el debate activo y responde a lo que dijeron los otros"

Todas las IAs leen y escriben en el **mismo archivo de estado** (`debates.json`), así que todo es visible para todos en tiempo real.

---

## Arquitectura

### Modo stdio (cada cliente lanza su proceso)
```
Claude Desktop ──┐
Cursor          ──┼── stdio ──► mcp-server.js ──► debate-manager.cjs ──► debates.json
Otra IA MCP     ──┘                                                      (compartido)
```

### Modo HTTP/SSE (un server, múltiples clientes por URL)
```
                              ┌── GET /sse ──────── canal SSE persistente
IA-1 ──┐                     │
IA-2 ──┼── http://host:3000 ─┼── POST /messages ── envío de tool calls
IA-3 ──┘                     │
                              └── GET / ─────────── health check / info
                                    │
                                    ▼
                            debate-manager.cjs ──► debates.json
```

## Notas

- El server no usa `console.log` (corrupta stdio). Usa `console.error` para logs.
- Los debates se guardan en `debates.json` y sobreviven reinicios.
- Al finalizar, se exporta un `.md` con todo el historial.
- En modo HTTP, `GET /` devuelve JSON con el estado del server y debate activo.
- Puedes exponer el server a internet con `ngrok http 3000` para que IAs remotas se conecten.
