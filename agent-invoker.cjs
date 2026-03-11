/**
 * Agent Invoker — Invoca agentes de Claude Code con retry y métricas
 *
 * Centraliza toda la comunicación con claude -p.
 * Maneja timeouts, retries, y logging de métricas.
 */

const { exec } = require('child_process');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');

/**
 * Invoca un agente y retorna su respuesta
 *
 * @param {string} agentName - Nombre del agente (.claude/agents/*.md)
 * @param {string} prompt - El prompt completo
 * @param {Object} options
 * @param {string} options.model - Modelo a usar (sonnet, opus)
 * @param {string} options.effort - Nivel de esfuerzo (medium, high, max)
 * @param {number} options.timeout - Timeout en ms (default 120000)
 * @param {number} options.retryMax - Max intentos (default 2)
 * @returns {Promise<{response: string, attempts: number, elapsed: number}>}
 */
async function invokeAgent(agentName, prompt, options = {}) {
  const {
    model = 'sonnet',
    effort = 'medium',
    timeout = 120_000,
    retryMax = 2,
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= retryMax; attempt++) {
    const startTime = Date.now();

    try {
      const response = await executeClaudeCLI(agentName, prompt, { model, effort, timeout });
      const elapsed = Date.now() - startTime;

      if (response && response.trim().length > 10) {
        return { response: response.trim(), attempts: attempt, elapsed };
      }

      // Empty response — retry with diagnostic
      lastError = 'Empty response';
      if (attempt < retryMax) {
        prompt = `Tu respuesta anterior fue vacia. Responde al tema original.\n\n${prompt}`;
      }
    } catch (err) {
      lastError = err.message || 'Unknown error';
      // Only retry on timeout, not on other errors
      if (!lastError.includes('TIMEOUT') && !lastError.includes('timeout')) {
        break;
      }
    }
  }

  return {
    response: `[Error: ${agentName} no respondio despues de ${retryMax} intentos - ${(lastError || '').slice(0, 100)}]`,
    attempts: retryMax,
    elapsed: 0,
  };
}

/**
 * Ejecuta claude CLI como child process
 * @returns {Promise<string>}
 */
function executeClaudeCLI(agentName, prompt, { model, effort, timeout }) {
  return new Promise((resolve, reject) => {
    const child = exec(
      `claude -p --agent "${agentName}" --model ${model} --effort ${effort} --tools ""`,
      {
        cwd: PROJECT_DIR,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024 * 10,
        shell: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(err.message?.slice(0, 200) || 'CLI error'));
        } else {
          resolve(stdout);
        }
      }
    );

    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

/**
 * Invoca múltiples agentes en paralelo
 *
 * @param {Array<{agent: string, prompt: string}>} tasks
 * @param {Object} options - Same as invokeAgent options
 * @returns {Promise<Array<{agent: string, response: string, attempts: number, elapsed: number}>>}
 */
async function invokeParallel(tasks, options = {}) {
  const results = await Promise.all(
    tasks.map(async ({ agent, prompt }) => {
      const result = await invokeAgent(agent, prompt, options);
      return { agent, ...result };
    })
  );
  return results;
}

/**
 * Invoca agentes secuencialmente con orden rotado
 *
 * @param {string[]} agents - Lista de agentes
 * @param {Function} promptFn - Función que recibe (agentName, index) y retorna prompt
 * @param {Object} options
 * @param {number} options.rotateBy - Posiciones a rotar (default 0)
 * @returns {Promise<Array<{agent: string, response: string, attempts: number, elapsed: number}>>}
 */
async function invokeSequential(agents, promptFn, options = {}) {
  const { rotateBy = 0, ...invokeOptions } = options;

  // Rotar orden de agentes
  const rotated = rotateBy > 0
    ? [...agents.slice(rotateBy % agents.length), ...agents.slice(0, rotateBy % agents.length)]
    : agents;

  const results = [];

  for (let i = 0; i < rotated.length; i++) {
    const agent = rotated[i];
    const prompt = await promptFn(agent, i);
    const result = await invokeAgent(agent, prompt, invokeOptions);
    results.push({ agent, ...result });
  }

  return results;
}

module.exports = {
  invokeAgent,
  invokeParallel,
  invokeSequential,
};
