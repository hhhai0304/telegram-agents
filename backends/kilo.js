'use strict';
/* Backend: Kilo CLI (`kilo`), a fork of OpenCode. See opencode-family.js. */
const { make, defaultDataDir } = require('./opencode-family.js');
/* Buttons for /model. Kilo ids are `<provider>/<model>`, and reaching a model
 * through OpenRouter makes that two levels deep -- hence `openrouter/...`.
 * Any other id from `kilo models` still works by typing it. */
const MODELS = [
  'openrouter/deepseek/deepseek-v4-flash-0731',  // default — code thông thường
  'openrouter/moonshotai/kimi-k3',               // max     — việc siêu khó
  'openrouter/deepseek/deepseek-v4-pro-0813',    // high    — lên plan, tổng quan
  'openrouter/qwen/qwen3.7-plus',                // image   — task cần xem ảnh
  'openrouter/qwen/qwen3.7-flash',               // fast    — quick check, commit msg
];

module.exports = make({
  id: 'kilo', name: 'Kilo CLI', bin: 'kilo',
  dataDir: process.env.TGA_KILO_DATA_DIR || defaultDataDir('kilo'),
  models: MODELS,
  defaultModel: MODELS[0],
});
