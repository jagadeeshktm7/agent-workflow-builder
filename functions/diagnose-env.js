// Temporary diagnostic: report which env vars the functions runtime actually
// receives (names + masked presence only). Remove once env delivery is fixed.
module.exports = async function diagnoseEnv(req, res) {
  const interesting = Object.keys(process.env)
    .filter((k) => /GEMINI|NHOST|HASURA/.test(k))
    .sort();
  res.json({
    envs: interesting.map((k) => {
      const v = process.env[k] || '';
      return { name: k, present: v.length > 0, len: v.length, head: v.slice(0, 6) };
    }),
    gemini_status: process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
  });
};