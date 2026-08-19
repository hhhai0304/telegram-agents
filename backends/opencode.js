'use strict';
/* Backend: OpenCode (`opencode`). See opencode-family.js. */
const { make, defaultDataDir } = require('./opencode-family.js');
module.exports = make({
  id: 'opencode', name: 'OpenCode', bin: 'opencode',
  dataDir: process.env.TGA_OPENCODE_DATA_DIR || defaultDataDir('opencode'),
});
