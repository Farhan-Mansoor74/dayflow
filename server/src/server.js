require('dotenv').config();
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');

const port = Number(process.env.PORT) || 3088;
const app = createApp();

const server = app.listen(port, () => {
  console.log(`[dayflow] API listening on http://localhost:${port}`);
  console.log(`[dayflow] health: http://localhost:${port}/api/health`);
  startScheduler();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
