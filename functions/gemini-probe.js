// Temporary probe: does a bare Gemini call work in this runtime? Returns the
// raw outcome (or the exception) so we can tell SDK problems from engine wiring.
const { GoogleGenAI } = require('@google/genai');

const MODELS = [
  'gemini-3.6-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
];

module.exports = async function geminiProbe(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.json({ ok: false, stage: 'no-key' });
  const genai = new GoogleGenAI({ apiKey: key });
  const results = [];
  for (const model of MODELS) {
    try {
      const t0 = Date.now();
      const interaction = await genai.interactions.create({
        model,
        system_instruction: 'Reply with exactly one word.',
        input: 'Say the single word: yes',
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      });
      results.push({ model, ok: true, ms: Date.now() - t0, output: interaction.output_text });
    } catch (err) {
      results.push({ model, ok: false, name: err?.name || String(err), message: (err?.message || String(err)).slice(0, 300) });
    }
  }
  return res.json({ results });
};