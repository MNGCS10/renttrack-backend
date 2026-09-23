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

app.get("/", (c) => c.text("RentTrack backend is running."));

// ชั่วคราว — ดัก LINE userId ตอนทักแชท (เอาไปตั้ง LINE_ALERT_TARGET_ID)
// ไปตั้ง Webhook URL นี้ใน LINE Developers Console แล้วส่งข้อความหา OA ดูใน Render log
app.post("/line/webhook", async (c) => {
  const body = await c.req.json();
  console.log("LINE webhook event:", JSON.stringify(body));
  return c.json({ ok: true });
});

app.post("/api/device/ping", async (c) => {
  const body = await c.req.json<PingPayload>();
  const { device_id, lat, lng, speed_kmh, heading, battery_pct } = body;

  if (!device_id || lat == null || lng == null) {
    return c.json({ error: "missing device_id/lat/lng" }, 400);
  }

  // 1. โหลด device + tenant + vehicle + active rental (ถ้ามี)
  const { data: device, error: deviceErr } = await supabase
    .from("devices")
    .select("id, tenant_id, vehicle_id, status, tenants!inner(status)")
    .eq("id", device_id)
    .single();

  if (deviceErr || !device) {
    return c.json({ error: "unknown device" }, 404);
  }

  // 1b. ปฏิเสธ ping ถ้า tenant ถูกระงับ (ไม่จ่ายค่าบริการ) — ไม่ต้องแตะ infra เลย
  // แค่เปลี่ยน tenants.status = 'suspended' ใน DB มือถือของลูกค้ารายนั้นก็หยุดอัปเดตทันที
  const tenantStatus = (device as any).tenants?.status;
  if (tenantStatus === "suspended") {
    return c.json({ error: "tenant suspended — service paused" }, 403);
  }

  const { data: activeRental } = await supabase
    .from("rentals")
    .select("id, planned_end_at")
    .eq("vehicle_id", device.vehicle_id)
    .eq("status", "active")
    .maybeSingle();

  // 2. ดึงตำแหน่งล่าสุดของ device นี้ (สำหรับเช็ค movement)
  const { data: lastPos } = await supabase
    .from("positions")
    .select("lat, lng, recorded_at")
    .eq("device_id", device_id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const now = new Date();
  let distanceMoved = 0;
  if (lastPos) {
    distanceMoved = haversineMeters(lastPos.lat, lastPos.lng, lat, lng);
  }

  // 3. Insert position ใหม่
  await supabase.from("positions").insert({
    device_id,
    rental_id: activeRental?.id ?? null,
    lat,
    lng,
    speed_kmh: speed_kmh ?? null,
    heading: heading ?? null,
    recorded_at: now.toISOString(),
  });

  // 4. Append เข้า rental_routes ถ้ามี rental active (route jsonb pattern จาก MedMove)
  if (activeRental) {
    await supabase.rpc("append_rental_route_point", {
      p_rental_id: activeRental.id,
      p_point: { lat, lng, speed: speed_kmh ?? null, t: now.toISOString() },
    });
  }

  // 5. Update device heartbeat
  await supabase
    .from("devices")
    .update({
      last_ping_at: now.toISOString(),
      battery_pct: battery_pct ?? null,
      status: "active",
    })
    .eq("id", device_id);

  // 6. Alert engine — เช็คทุก rule ที่ enabled สำหรับ tenant นี้
  await runAlertChecks({
    tenantId: device.tenant_id,
    vehicleId: device.vehicle_id,
    rentalId: activeRental?.id ?? null,
    lat,
    lng,
    distanceMoved,
    hasActiveRental: !!activeRental,
  });

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------
// Alert engine
// ---------------------------------------------------------------------
async function runAlertChecks(params: {
  tenantId: string;
  vehicleId: string;
  rentalId: string | null;
  lat: number;
  lng: number;
  distanceMoved: number;
  hasActiveRental: boolean;
}) {
  const { tenantId, vehicleId, rentalId, lat, lng, distanceMoved, hasActiveRental } = params;

  const { data: rules } = await supabase
    .from("alert_rules")
    .select("rule_type, enabled, threshold_minutes")
    .eq("tenant_id", tenantId)
    .eq("enabled", true);

  if (!rules || rules.length === 0) return;

  const ruleMap = Object.fromEntries(rules.map((r) => [r.rule_type, r]));

  // --- movement_without_rental: รถขยับ (>threshold) แต่ไม่มีสัญญาเช่า active ---
  if (ruleMap["movement_without_rental"] && !hasActiveRental && distanceMoved > MOVEMENT_THRESHOLD_M) {
    await raiseAlert({
      tenantId,
      vehicleId,
      rentalId,
      alertType: "movement_without_rental",
      message: `รถขยับ ${Math.round(distanceMoved)} ม. ทั้งที่ไม่มีสัญญาเช่า active — เช็คด่วน`,
      lat,
      lng,
    });
  }

  // --- geofence_exit / geofence_enter_restricted ---
  if (ruleMap["geofence_exit"] || ruleMap["geofence_enter_restricted"]) {
    const { data: zones } = await supabase
      .from("geofence_zones")
      .select("id, name, center_lat, center_lng, radius_m, zone_type")
      .eq("tenant_id", tenantId)
      .eq("active", true);

    for (const zone of zones ?? []) {
      const dist = haversineMeters(lat, lng, zone.center_lat, zone.center_lng);
      const inside = dist <= zone.radius_m;

      if (zone.zone_type === "allowed" && !inside && ruleMap["geofence_exit"]) {
        await raiseAlert({
          tenantId,
          vehicleId,
          rentalId,
          alertType: "geofence_exit",
          message: `รถออกนอกเขต "${zone.name}"`,
          lat,
          lng,
        });
      }
      if (zone.zone_type === "restricted" && inside && ruleMap["geofence_enter_restricted"]) {
        await raiseAlert({
          tenantId,
          vehicleId,
          rentalId,
          alertType: "geofence_enter_restricted",
          message: `รถเข้าเขตห้าม "${zone.name}"`,
          lat,
          lng,
        });
      }
    }
  }

  // --- overdue_return: เช็คแยกเป็น cron job ต่างหาก ไม่เหมาะเช็คทุก ping ---
  // --- device_offline: เช็คแยกเป็น cron job (scan devices.last_ping_at) ---
}

async function raiseAlert(params: {
  tenantId: string;
  vehicleId: string;
  rentalId: string | null;
  alertType: string;
  message: string;
  lat: number;
  lng: number;
}) {
  // กันแจ้งซ้ำถี่เกินไป — เช็ค alert ประเภทเดียวกัน ในช่วง 5 นาทีล่าสุด ของ vehicle เดียวกัน
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("alerts")
    .select("id")
    .eq("vehicle_id", params.vehicleId)
    .eq("alert_type", params.alertType)
    .gte("created_at", fiveMinAgo)
    .limit(1);

  if (recent && recent.length > 0) return; // เพิ่งแจ้งไปแล้ว ข้าม

  await supabase.from("alerts").insert({
    tenant_id: params.tenantId,
    vehicle_id: params.vehicleId,
    rental_id: params.rentalId,
    alert_type: params.alertType,
    message: params.message,
    lat: params.lat,
    lng: params.lng,
  });

  await sendLineAlert(params.tenantId, params.message, params.lat, params.lng);
}

// ---------------------------------------------------------------------
// LINE push — ส่งแจ้งเตือนเข้า LINE ตอนเกิด alert จริง
// ---------------------------------------------------------------------
async function sendLineAlert(tenantId: string, message: string, lat: number, lng: number) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetId = process.env.LINE_ALERT_TARGET_ID; // user ID หรือ group ID ที่จะรับแจ้งเตือน

  if (!token || !targetId) return; // ยังไม่ตั้งค่า — ข้ามไปเงียบ ๆ ไม่ทำให้ ping หลักพัง

  const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;

  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: targetId,
        messages: [
          {
            type: "text",
            text: `🚨 RentTrack แจ้งเตือน\n\n${message}\n\n📍 ${mapUrl}`,
          },
        ],
      }),
    });
  } catch (err) {
    console.error("LINE push failed:", err); // ไม่ throw — alert บันทึกลง DB สำเร็จแล้ว ไม่อยากให้ ping ทั้งเส้น fail เพราะ LINE ล่ม
  }
}

export default app;

/* =====================================================================
 * SQL helper function ที่ต้อง apply ใน Supabase ก่อนใช้งาน (ทำไปแล้วตอน apply schema):
 *
 * create or replace function append_rental_route_point(p_rental_id uuid, p_point jsonb)
 * returns void language sql set search_path = public as $$
 *   insert into rental_routes (rental_id, route, updated_at)
 *   values (p_rental_id, jsonb_build_array(p_point), now())
 *   on conflict (rental_id) do update
 *   set route = rental_routes.route || p_point, updated_at = now();
 * $$;
 * ===================================================================== */
