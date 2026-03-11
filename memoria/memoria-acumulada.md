# Memoria Acumulada — Multi-Agent Chat
> Total de sesiones: 2
> Ultima actualizacion: 10/3/2026, 1:20:11 p.m.

---

## Sesion #1 (10/3/2026)
**Tema:** Como mejorar la integracion de IA en Axon

**Ideas clave:**
- LearningEvent como tipo fundacional que capture toda interacción con granularidad incluyendo confidenceLevel, responseTimeMs y eliminatedOptions
- Grafo dirigido competency-graph.ts con aristas tipadas entre keywords que reemplaza el array plano relatedKeywords
- Endpoint /ai/next-learning-action como cerebro unificado con fallback determinístico local via learning-orchestrator.ts
- Quiz encadenado adaptativo donde cada respuesta condiciona la siguiente recorriendo el competency-graph según espectro BKT
- Content Assistant para profesores con validación humana obligatoria que cierra el loop datos-IA-acción docente

**Decisiones:**
- LearningEvent es prerequisito P0 de todo: ambas salas convergieron en capturar datos ricos antes de cualquier feature de IA
- El budget de tokens se gestiona server-side en la Edge Function, no en AppContext del frontend donde un refresh lo resetearía
- TeachBackCard explica-a-la-IA como v1 en vez de peer-to-peer social, dejando el modelo social como visión futura sin timeline

---

## Sesion #2 (10/3/2026)
**Tema:** Como mejorar este sistema de multi-agent chat? Tienen acceso al codigo y arquitectura completa en el contexto. Propongan mejoras concretas al orchestrator, vector store, prompts, y experiencia. Al final generen prompts de accion para implementar las mejoras.

**Ideas clave:**
- Pipeline tipada end-to-end con SessionTypes, Checkpoints estructurados y action-items.json en vez de markdown libre
- Agent-Invoker con dual-path retry y ronda 1 en paralelo con Promise.all para ahorrar 30% del tiempo
- Cierre automático de action items por git commits más SM-2 lite para competencias de agentes
- Rotación de orden de agentes entre rondas más quality gate observacional con métricas
- Report post-sesión con session-report.md y prompt versioning para correlacionar cambios con calidad

**Decisiones:**
- Implementar primero ronda 1 en paralelo, rotación de orden y métricas básicas como quick wins en orchestrator-v2.cjs
- Quality gate arranca en modo observacional sin bloqueo, calibrar thresholds después de 5-10 sesiones con datos reales
- Competencias de agentes estáticas en Fase 1, SM-2 dinámico en Fase 3, índice semántico solo si se demuestra necesario

---

