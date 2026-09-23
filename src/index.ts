// =====================================================================
// RentTrack Backend — Entry point for Render (Node.js runtime)
// รัน Hono app เดียวกับที่ใช้ทดสอบ ผ่าน @hono/node-server
// =====================================================================
import { serve } from "@hono/node-server";
import app from "./ingest.js";

const port = Number(process.env.PORT) || 3000;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`RentTrack backend listening on port ${info.port}`);
});
