/**
 * Task 29b — pre-warm the local Ollama model at server boot.
 *
 * phi takes ~60-70s to load into memory on a cold start but only ~2-5s once resident.
 * Without a warm-up, the first user whose question needs phi pays that cold-start cost
 * and — with the default 20s timeout — usually just gets the generic canned fallback
 * instead. This fires one throwaway request at startup so the model is already loaded
 * before real traffic arrives.
 *
 * Fire-and-forget: never blocks startup, never throws. If Ollama is down or the model
 * isn't pulled, it logs a warning and the app runs exactly as before (deterministic
 * replies, phi fallback attempted per-request).
 */
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi:latest';
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '10m';
// Generous — a cold load can take over a minute; we're not making a user wait on this.
const WARMUP_TIMEOUT_MS = Number(process.env.OLLAMA_WARMUP_TIMEOUT_MS || 120000);

async function warmUpOllama() {
  if (/^(0|false|no|off)$/i.test(String(process.env.OLLAMA_WARMUP || ''))) {
    console.log('🔥 Ollama warm-up skipped (OLLAMA_WARMUP is off)');
    return;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_predict: 1, temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama responded ${res.status}`);
    }
    await res.json();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`🔥 Ollama warm-up complete: "${OLLAMA_MODEL}" resident in ${secs}s (keep_alive ${OLLAMA_KEEP_ALIVE})`);
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `no response within ${WARMUP_TIMEOUT_MS / 1000}s`
      : (err && err.message) || 'unknown error';
    console.warn(`⚠️ Ollama warm-up failed (${reason}) — phi fallback will still be attempted per request, first one may be slow.`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { warmUpOllama };
