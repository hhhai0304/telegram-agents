'use strict';
/* Backend: Kilo CLI (`kilo`), a fork of OpenCode. See opencode-family.js. */
const { make, defaultDataDir } = require('./opencode-family.js');
module.exports = make({
  id: 'kilo', name: 'Kilo CLI', bin: 'kilo',
  dataDir: process.env.TGA_KILO_DATA_DIR || defaultDataDir('kilo'),
});
