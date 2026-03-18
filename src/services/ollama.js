const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = 'qwen3-embedding:0.6b';
const TIMEOUT_MS = 3000;

/**
 * Generate a 1024-dim embedding for the given text.
 * Returns the embedding array or null on error.
 */
async function generateEmbedding(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`Ollama embed failed: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (!data.embeddings || !Array.isArray(data.embeddings[0])) {
      console.error('Ollama embed: unexpected response shape');
      return null;
    }

    return data.embeddings[0];
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('Ollama embed: request timed out');
    } else {
      console.warn(`Ollama embed: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if Ollama is reachable and the embedding model is available.
 */
async function checkHealth() {
  try {
    const response = await fetch(OLLAMA_URL, { method: 'GET' });
    if (!response.ok) {
      return { available: false, model: MODEL };
    }
    return { available: true, model: MODEL };
  } catch {
    return { available: false, model: MODEL };
  }
}

module.exports = { generateEmbedding, checkHealth };
