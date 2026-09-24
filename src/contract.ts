// =====================================================================
// RentTrack — Contract PDF Generator
// สร้างสัญญาเช่ารถเป็น PDF ด้วย pdf-lib + ฝังฟอนต์ไทย (Sarabun)
// pdf-lib ไม่รองรับภาษาไทยในตัว ต้อง embed font เองผ่าน fontkit เสมอ
// =====================================================================

import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ContractData {
  tenantName: string;
  vehiclePlate: string;
  vehicleBrand: string;
  vehicleModel: string;
  vehicleColor: string;
  renterName: string;
  renterPhone: string;
  renterIdNumber: string;
  renterAddress: string;
  startDate: string;
  endDate: string;
  priceTotal: number;
  depositAmount: number;
  days: number;
}

export async function generateContractPdf(data: ContractData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const regularBytes = fs.readFileSync(path.join(__dirname, "../assets/fonts/Sarabun-Regular.ttf"));
  const boldBytes = fs.readFileSync(path.join(__dirname, "../assets/fonts/Sarabun-Bold.ttf"));
  const font = await pdfDoc.embedFont(regularBytes);
  const fontBold = await pdfDoc.embedFont(boldBytes);

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width } = page.getSize();
  const margin = 50;
  let y = 780;

  const ink = rgb(0.09, 0.14, 0.13);
  const muted = rgb(0.4, 0.43, 0.42);
  const line = rgb(0.85, 0.83, 0.79);

  function text(str: string, x: number, yPos: number, size: number, useFont = font, color = ink) {
    page.drawText(str, { x, y: yPos, size, font: useFont, color });
  }
  function hr(yPos: number) {
    page.drawLine({ start: { x: margin, y: yPos }, end: { x: width - margin, y: yPos }, thickness: 0.75, color: line });
  }

  // ---------- หัวเอกสาร ----------
  text("สัญญาเช่ารถยนต์", margin, y, 20, fontBold);
  y -= 18;
  text(`ผู้ให้เช่า: ${data.tenantName}`, margin, y, 11, font, muted);
  y -= 26;
  hr(y);
  y -= 28;

  // ---------- ข้อมูลรถ ----------
  text("รายละเอียดรถ", margin, y, 13, fontBold);
  y -= 20;
  text(`ทะเบียน: ${data.vehiclePlate}`, margin, y, 11);
  text(`ยี่ห้อ/รุ่น: ${data.vehicleBrand} ${data.vehicleModel}`, margin + 260, y, 11);
  y -= 18;
  text(`สี: ${data.vehicleColor || "-"}`, margin, y, 11);
  y -= 30;

  // ---------- ข้อมูลผู้เช่า ----------
  text("ข้อมูลผู้เช่า", margin, y, 13, fontBold);
  y -= 20;
  text(`ชื่อ-นามสกุล: ${data.renterName}`, margin, y, 11);
  y -= 18;
  text(`เบอร์โทรศัพท์: ${data.renterPhone}`, margin, y, 11);
  text(`เลขบัตรประชาชน/พาสปอร์ต: ${data.renterIdNumber || "-"}`, margin + 260, y, 11);
  y -= 18;
  text(`ที่อยู่: ${data.renterAddress || "-"}`, margin, y, 11);
  y -= 30;

  // ---------- ระยะเวลาเช่า + ราคา ----------
  text("ระยะเวลาเช่าและค่าใช้จ่าย", margin, y, 13, fontBold);
  y -= 20;
  text(`วันที่รับรถ: ${new Date(data.startDate).toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })}`, margin, y, 11);
  y -= 18;
  text(`วันที่คืนรถ: ${new Date(data.endDate).toLocaleDateString("th-TH", { year: "numeric", month: "long", day: "numeric" })}`, margin, y, 11);
  y -= 18;
  text(`จำนวนวันเช่า: ${data.days} วัน`, margin, y, 11);
  y -= 24;
  hr(y);
  y -= 20;
  text(`ค่าเช่ารวม`, margin, y, 11);
  text(`${data.priceTotal.toLocaleString()} บาท`, width - margin - 100, y, 11, fontBold);
  y -= 18;
  text(`เงินมัดจำ`, margin, y, 11);
  text(`${data.depositAmount.toLocaleString()} บาท`, width - margin - 100, y, 11, fontBold);
  y -= 18;
  hr(y);
  y -= 20;
  text(`รวมทั้งสิ้น`, margin, y, 13, fontBold);
  text(`${(data.priceTotal + data.depositAmount).toLocaleString()} บาท`, width - margin - 110, y, 13, fontBold);
  y -= 36;

  // ---------- เงื่อนไขสัญญา ----------
  text("เงื่อนไขการเช่า", margin, y, 13, fontBold);
  y -= 20;
  const terms = [
    "1. ผู้เช่าต้องมีใบอนุญาตขับขี่ที่ยังไม่หมดอายุ และเป็นผู้ขับขี่ตลอดระยะเวลาเช่า",
    "2. ผู้เช่าต้องคืนรถตามวันและเวลาที่ระบุ หากคืนล่าช้าจะมีค่าปรับตามอัตราที่ผู้ให้เช่ากำหนด",
    "3. ผู้เช่าต้องรับผิดชอบค่าน้ำมันเชื้อเพลิงระหว่างการเช่า และคืนรถพร้อมระดับน้ำมันเท่าที่รับมา",
    "4. ความเสียหายที่เกิดกับตัวรถระหว่างการเช่า ผู้เช่าเป็นผู้รับผิดชอบค่าซ่อมแซมทั้งหมด",
    "5. เงินมัดจำจะคืนให้ภายหลังตรวจสอบสภาพรถเรียบร้อยแล้ว หักค่าเสียหาย (ถ้ามี)",
    "6. ห้ามนำรถไปใช้ในทางผิดกฎหมาย หรือให้บุคคลอื่นที่ไม่ได้รับอนุญาตขับขี่โดยเด็ดขาด",
  ];
  terms.forEach((t) => {
    text(t, margin, y, 9.5, font, muted);
    y -= 16;
  });

  y -= 30;
  hr(y);
  y -= 40;

  // ---------- ลายเซ็น ----------
  text("ลงชื่อ ....................................................", margin, y, 11);
  text("ลงชื่อ ....................................................", margin + 260, y, 11);
  y -= 18;
  text("(ผู้ให้เช่า)", margin + 60, y, 10, font, muted);
  text("(ผู้เช่า)", margin + 310, y, 10, font, muted);
  y -= 30;
  text(`เอกสารนี้สร้างโดยระบบอัตโนมัติ RentTrack เมื่อ ${new Date().toLocaleString("th-TH")}`, margin, 40, 8, font, muted);

  return pdfDoc.save();
}
