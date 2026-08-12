// Temporary probe: does a bare Gemini call work in this runtime? Returns the
// raw outcome (or the exception) so we can tell SDK problems from engine wiring.
const { GoogleGenAI } = require('@google/genai');

module.exports = async function geminiProbe(req, res) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.json({ ok: false, stage: 'no-key' });
    const genai = new GoogleGenAI({ apiKey: key });
    const t0 = Date.now();
    const interaction = await genai.interactions.create({
      model: 'gemini-3.6-flash',
      system_instruction: 'Reply with exactly one word.',
      input: 'Say the single word: yes',
    });
    return res.json({ ok: true, ms: Date.now() - t0, output: interaction.output_text });
  } catch (err) {
    return res.json({ ok: false, stage: 'call', name: err?.name || String(err), message: err?.message || String(err), stack: (err?.stack || '').split('\n').slice(0, 4) });
  }
};