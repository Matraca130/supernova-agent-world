# TEST-PLAN — Multi-Agent Chat System

Tests manuales para validar el sistema antes de cada release.

---

## T1: Invocación básica de agente
```bash
node -e "const {invokeAgent}=require('./multi-agent-chat/agent-invoker.cjs'); invokeAgent('arquitecto','Di hola en una linea').then(r=>console.log(r.response?.slice(0,100)))"
```
**Esperado:** Respuesta no vacía del agente arquitecto.
**Falla si:** Error ENOENT, timeout, respuesta vacía.

## T2: Checkpoint parsing
```bash
node -e "const {parseCheckpoint}=require('./multi-agent-chat/prompt-builder.cjs'); const raw='texto\n---CHECKPOINT---\n{\"consenso\":[\"test\"],\"divergencias\":[],\"accionable\":[\"hacer X\"],\"preguntas\":[]}\n---END---'; const cp=parseCheckpoint(raw,'test',1); console.log(JSON.stringify(cp))"
```
**Esperado:** Checkpoint con `consenso: ["test"]`, `accionable: ["hacer X"]`, `structured: true`.
**Falla si:** `structured: false` o campos vacíos.

## T3: Vector store embed + search
```bash
node -e "const vs=require('./multi-agent-chat/memoria/vector-store.cjs'); vs.addMemory('test memory for validation','ideas',{test:true}).then(()=>vs.searchMemories('test validation',1)).then(r=>console.log(r))"
```
**Esperado:** Resultado con score > 0.5. Requiere Ollama corriendo.
**Falla si:** Error de conexión o score < 0.3.

## T4: SM-2 competence update
```bash
node -e "const {updateCompetence}=require('./multi-agent-chat/sm2-lite.cjs'); const c={easeFactor:2.5,interval:1,repetitions:0}; console.log(updateCompetence(c,5)); console.log(updateCompetence(c,0))"
```
**Esperado:** quality=5 incrementa easeFactor y repetitions. quality=0 resetea a interval=1, repetitions=0.
**Falla si:** easeFactor < 1.3 o campos undefined.

## T5: Quality gate scoring
```bash
node -e "const {measureSpecificity}=require('./multi-agent-chat/quality-gate.cjs'); console.log(measureSpecificity('Modificar src/app/services/api.ts linea 42, usar useQuizSession hook, endpoint POST /quiz/submit')); console.log(measureSpecificity('hacer algo mejor'))"
```
**Esperado:** Primera respuesta > 0.3, segunda < 0.1.
**Falla si:** Ambas iguales o invertidas.

## T6: Git tracker tag extraction
```bash
node -e "const {extractTags}=require('./multi-agent-chat/git-tracker.cjs'); console.log(extractTags('fix: quiz validation [mac-001] [mac-002]'))"
```
**Esperado:** `['mac-001', 'mac-002']`
**Falla si:** Array vacío o tags mal parseados.

## T7: Action items deduplication
```bash
node -e "const {formatActionItems}=require('./multi-agent-chat/output-formatter.cjs'); const cps=[{agentName:'test',accionable:['Crear tests unitarios','Crear tests unitarios','Refactorizar API']},{agentName:'test2',accionable:['Crear tests unitarios']}]; console.log(formatActionItems(cps,'test-session').length)"
```
**Esperado:** 2 items (no 3), el duplicado se deduplica. "Crear tests unitarios" es P0 (mencionado 3 veces).
**Falla si:** 3+ items o priority incorrecto.

## T8: Sesión completa (smoke test)
```bash
node multi-agent-chat/orchestrator-v3.cjs --quality stable --rounds 1 "Test de humo"
```
**Esperado:** Completa sin errores. Genera sala-estrategia.md y sala-implementacion.md.
**Falla si:** Crash, timeout indefinido, o archivos no generados.

---

## Checklist pre-release
- [ ] T1 pasa
- [ ] T2 pasa
- [ ] T3 pasa (con Ollama)
- [ ] T4 pasa
- [ ] T5 pasa
- [ ] T6 pasa
- [ ] T7 pasa (limpiar action-items.json antes)
- [ ] T8 pasa
- [ ] Todos los archivos son .cjs
- [ ] No hay imports de framer-motion
- [ ] INVARIANTS.md revisado
