// Local / self-hosted entry: a normal Node HTTP server.
//   npm start            -> http://localhost:3000, embedded database in ./data (or DATABASE_URL)
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const db = await openDb();
const { app } = await createApp({ db });
app.listen(port, () => console.log(`MCP market on :${port}  (MCP endpoint: ${process.env.PUBLIC_URL || `http://localhost:${port}`}/mcp)`));
