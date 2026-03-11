# Auditoría del Sistema Multi-Agent Debate MCP
**Fecha:** 2026-03-10
**Archivos:** debate-manager.cjs (1345 líneas) + mcp-server.js (1494 líneas) = 2839 líneas total
**Tools MCP:** 19
**Funciones exportadas:** 22

---

## 1. REDUNDANCIAS ENCONTRADAS

### 1.1 `orquestar_debate` vs `situacion` — SOLAPAMIENTO ALTO

| Aspecto | `orquestar_debate` | `situacion` |
|---------|-------------------|-------------|
| Crea debate | Sí (via `autoDebate → createDebate`) | Sí (lógica propia en `crearSituacion`) |
| Registra N agentes | Sí (loop joinDebate) | Sí (loop joinDebate) |
| Retorna firstTurn | Sí | Sí |
| Usa template | No (roles auto-detectados) | Sí (SITUACIONES predefinidas) |
| Tiene coordinación | No | Sí (dependencias entre agentes) |

**Problema:** `crearSituacion()` duplica la lógica de creación de debate que ya existe en `createDebate()`. Construye el objeto debate manualmente en vez de llamar `createDebate()` y extenderlo.

**Recomendación:** `crearSituacion()` debería llamar `createDebate()` internamente y luego agregar campos de situación (`coordination`, `situacionName`, etc.), en vez de duplicar la estructura.

**Alternativa radical:** Fusionar `orquestar_debate` dentro de `situacion` con tipo `tipo: "libre"` para debates sin template. Esto reduce 1 tool y 1 función.

### 1.2 `getNextTurn()` vs `getAllPendingTurns()` — LÓGICA DUPLICADA

Ambas funciones:
- Obtienen la fase actual
- Construyen mensajes recientes
- Detectan menciones
- Llaman `buildRolePlayPrompt()`

`getAllPendingTurns()` hace todo lo que `getNextTurn()` hace, pero para N agentes.

**Recomendación:** `getNextTurn()` debería ser un wrapper de `getAllPendingTurns()` que retorna solo el primer resultado.

### 1.3 Exports no utilizados por mcp-server.js

- `DEBATE_PHASES` — 0 usos
- `INTENSITY_RULES` — 0 usos
- `SITUACIONES` — 0 usos

Estos se exportan "por si acaso" pero ningún consumidor los usa directamente. No es grave (son datos de referencia), pero agregan ruido.

---

## 2. INEFICIENCIAS DE PERFORMANCE

### 2.1 `saveState()` — Serialización completa en cada operación

**Problema crítico para escalabilidad.** Cada llamada a `saveState()` serializa TODO el estado (todos los debates, todos los mensajes) a JSON y lo escribe a disco.

| Operación | saveState() calls |
|-----------|-------------------|
| `say()` | 1 (+ 1 si auto-join) |
| `joinDebate()` | 1 |
| `createDebate()` | 1 |
| `crearSituacion()` con 5 agentes | 1 + 5 (joinDebate) = 6 |
| `sayBatch()` con 10 agentes | 10 (llama say() 10 veces) |

**Con 10 agentes x 2 exchanges x 16 rondas = 320 llamadas a saveState().**
Si cada debate tiene 50KB+ de mensajes, estamos escribiendo 16MB+ total al disco.

**Recomendación:**
- Debounce saveState: guardar cada 5 segundos en vez de cada operación
- O: saveState solo al final de batch/ronda, no por cada say()
- sayBatch() debería hacer UN solo saveState al final, no N

### 2.2 Mensajes sin límite en memoria

`debate.messages` crece sin límite. Con 10 agentes haciendo 150+ palabras x 2 exchanges x 16 rondas:
- ~320 mensajes x ~150 palabras = ~48,000 palabras
- ~240KB en memoria solo para un debate
- `read()` retorna TODO el historial cada vez

**Recomendación:** Limitar mensajes recientes en `read()` con paginación default.

### 2.3 `buildRolePlayPrompt()` — contexto excesivo

Cada prompt incluye hasta 500 chars x N fuentes del KB. Con 10 fuentes = 5000+ chars solo de KB por agente. En `ronda_completa` con 10 agentes = 50,000+ chars de KB duplicado.

**Recomendación:** En `ronda_completa`, compartir el KB una vez como contexto global, no duplicarlo N veces.

---

## 3. TOOLS QUE SÍ SON NECESARIOS (NO eliminar)

| Tool | Razón |
|------|-------|
| `iniciar_debate` | Caso base: debate manual sin agentes |
| `unirse` | Necesario para que agentes reales se unan |
| `decir` | Core: enviar mensaje |
| `leer` | Core: leer historial |
| `avanzar_ronda` | Control manual de rondas |
| `finalizar` | Cierre con síntesis y export |
| `debates` | Listar debates |
| `estado` | Status general rápido |
| `roles` | Descubrimiento de roles |
| `agregar_contexto` | KB: inyectar evidencia |
| `consultar_fuente` | KB: leer fuente completa |
| `banco` | KB: listar fuentes |
| `turno` | Modo secuencial (1 agente a la vez) |
| `ronda_completa` | Modo paralelo (todos a la vez) |
| `decir_lote` | Batch de mensajes |
| `situacion` | Workflow templates |
| `situaciones` | Listar templates |
| `workflow_status` | Estado de coordinación |

### Tool candidato a eliminar o fusionar:

| Tool | Propuesta |
|------|-----------|
| `orquestar_debate` | Fusionar en `situacion` con tipo "libre" |

Eso dejaría **18 tools** — número sano para Figma Make.

---

## 4. ESCALABILIDAD: MÁS AGENTES SIMULTÁNEOS

### Límite actual: 5 agentes (hardcoded en orquestar_debate)

```javascript
const numAgents = Math.max(2, Math.min(5, num_agentes || 3));
```

`crearSituacion()` no tiene hard limit — usa `Math.min(numAgents, template.roles.length)` que está limitado por roles en el template (5 cada uno).

### Qué necesita cambiar para 10+ agentes:

**A) Subir el límite numérico:**
- Cambiar `Math.min(5, ...)` a `Math.min(15, ...)`
- Agregar más roles a los templates o permitir roles "extra" dinámicos

**B) Performance de ronda_completa:**
- Con 10 agentes, cada `ronda_completa` genera 10 prompts completos
- Cada prompt tiene ~2000 chars + KB
- Total response: 20,000-50,000 chars
- **Figma Make tiene límite de contexto** — esto puede ser un problema

**Recomendación para 10+ agentes:**
1. **Modo batch con prompts resumidos:** En vez de enviar el prompt completo de cada agente, enviar solo: nombre, rol, instrucción corta, y últimos 2 mensajes relevantes
2. **Dividir rondas en sub-grupos:** Con 10 agentes, hacer 2 sub-rondas de 5 en vez de 1 ronda de 10
3. **Lazy loading de KB:** No inyectar KB completo en cada prompt — que el agente llame `consultar_fuente` si necesita

**C) saveState con muchos agentes:**
- 10 agentes x 2 exchanges = 20 saveState() por ronda
- **Solución:** saveState debounced o batch-only

**D) Auto-redistribución con muchos agentes:**
- Con 10 virtuales y 3 reales entrando, la redistribución funciona bien
- Pero si entran 8 reales a un debate de 10 virtuales, hay 8 redistribuciones secuenciales con 8 saveState() cada una

### Arquitectura para máxima escala (10-20 agentes):

```
OPCIÓN 1: Sub-grupos (recomendado)
──────────────────────────────────
10 agentes → 2 mesas de 5
Cada mesa debate en paralelo
Mesa A: implementadores
Mesa B: revisores
Coordinador va entre mesas

OPCIÓN 2: Pipeline de salas
──────────────────────────────────
Sala 1: Detección (3 agentes)
  → output →
Sala 2: Análisis (3 agentes)
  → output →
Sala 3: Fix (4 agentes)
Cada sala es un debate independiente con su KB

OPCIÓN 3: Subir límite directo
──────────────────────────────────
Cambiar el cap de 5 a 15
Optimizar saveState (debounce)
Reducir prompt size en ronda_completa
Más roles genéricos disponibles
```

---

## 5. RESUMEN DE ACCIONES RECOMENDADAS

### Prioridad ALTA (performance):
1. **Debounce saveState()** — guardar máximo cada 3 segundos, no cada operación
2. **sayBatch() un solo saveState** — no N llamadas a say() con N saves
3. **KB compartido en ronda_completa** — no duplicar KB en cada prompt

### Prioridad MEDIA (limpieza):
4. **crearSituacion() debe usar createDebate()** internamente en vez de duplicar
5. **getNextTurn() como wrapper de getAllPendingTurns()** — eliminar duplicación
6. **Fusionar orquestar_debate dentro de situacion** — tipo "libre" para debate sin template

### Prioridad BAJA (nice to have):
7. Eliminar exports no usados (DEBATE_PHASES, INTENSITY_RULES, SITUACIONES)
8. Paginación en read() para debates largos
9. Prompts resumidos para 10+ agentes

### Para más agentes simultáneos:
10. **Subir cap a 15** — cambio trivial
11. **Agregar roles genéricos expandibles** — "analista-1", "analista-2", etc.
12. **Optimizar prompt size** — no incluir KB completo por agente en paralelo
