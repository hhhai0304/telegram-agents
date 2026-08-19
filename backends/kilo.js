'use strict';
/* Backend: Kilo CLI (`kilo`), a fork of OpenCode. See opencode-family.js. */
const { make, defaultDataDir } = require('./opencode-family.js');
/* Buttons for /model. Kilo ids are `<provider>/<model>`, and reaching a model
 * through OpenRouter makes that two levels deep -- hence `openrouter/openrouter/auto`,
 * which is OpenRouter's own router picking a model per request. Any other id
 * from `kilo models` still works by typing it. */
const MODELS = [
  'openrouter/openrouter/auto',
  'google/gemini-3.7-flash',              // Google AI Studio free tier (rate-limited)
  'openrouter/anthropic/claude-sonnet-5',
  'openrouter/anthropic/claude-opus-5',
  'openrouter/z-ai/glm-5.2:free',         // free with no Google quota to burn
];

module.exports = make({
  id: 'kilo', name: 'Kilo CLI', bin: 'kilo',
  dataDir: process.env.TGA_KILO_DATA_DIR || defaultDataDir('kilo'),
  models: MODELS,
  defaultModel: MODELS[0],
});
