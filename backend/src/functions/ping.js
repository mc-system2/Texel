// backend/src/functions/ping.js
import { app } from "@azure/functions";

app.http("ping", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async () => ({
    status: 200,
    jsonBody: {
      ok: true,
      env: process.env.APP_ENV ?? "local",
      time: new Date().toISOString(),
      "YES",
    },
  }),
});
