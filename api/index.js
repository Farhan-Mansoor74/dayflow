// Vercel serverless entry. Wraps the existing Express app (server/src/app.js)
// and serves every /api/* route. The reminder scheduler is NOT started here —
// on serverless there's no always-on process, so reminders are driven by an
// external cron hitting POST /api/cron/run (see DEPLOY-VERCEL.md).
const { createApp } = require('../server/src/app');

const app = createApp();

module.exports = app;
