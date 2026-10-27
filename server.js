// Kept so `node server.js` keeps working. The server now lives in server/, on top of
// the shared core/ that the CLI (`ai-media-studio`) and the MCP server also use.
require('./server/serve').main();
