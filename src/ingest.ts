// =====================================================================
// RentTrack — Phase 1 Ingest Endpoint (Hono)
// รับพิกัดจากมือถือติดรถ (PWA) → บันทึก position → เช็ค alert rules
// Pattern เดียวกับ MedMove driver-position ingest, ตัด emergency/medical ออก
// =====================================================================

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@supabase/supabase-js";

const app = new Hono();

// เปิด CORS — PWA tracker (Cloudflare) กับ backend (Render) อยู่คนละ origin กัน
// ไม่เปิดตรงนี้ browser จะบล็อก request ตั้งแต่ก่อนถึง server เลย (preflight fail)
app.use("/*", cors({ origin: "*", allowMethods: ["GET", "POST"] }));

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // service role — bypass RLS ฝั่ง backend
);

// ---------------------------------------------------------------------
// Haversine — ระยะทางระหว่าง 2 จุด (เมตร) — เหมือน pattern MedMove
// ---------------------------------------------------------------------
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ระยะที่นับว่า "ขยับจริง" ไม่ใช่ GPS drift เฉย ๆ (เมตร)
const MOVEMENT_THRESHOLD_M = 30;

interface PingPayload {
  device_id: string;
  lat: number;
  lng: number;
  speed_kmh?: number;
  heading?: number;
  battery_pct?: number;
}

app.get("/", (c)
