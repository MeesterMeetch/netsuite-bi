import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import html2pdf from "html2pdf.js";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer,
} from "recharts";

// ---------- utils ----------
const fmtCurrency = (v) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v) || 0);
const fmtPct = (v, d = 1) => `${(Number(v) || 0).toFixed(d)}%`;
const fmtInt = (v) => (Number(v) || 0).toLocaleString();
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + (Number(b) || 0), 0) / arr.length : 0);
const lowerKeys = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [String(k).toLowerCase().trim(), v]));
const pick = (obj, keys) => {
  const l = lowerKeys(obj);
  for (const k of keys) {
    const v = l[String(k).toLowerCase().trim()];
    if (v !== undefined) return v;
  }
  // contains match
  for (const k of Object.keys(l)) {
    if (keys.some((cand) => k.includes(String(cand).toLowerCase().trim()))) return l[k];
  }
  return undefined;
};

function ensureExt(file, allowed) {
  const ok = allowed.some((e) => file.name.toLowerCase().endsWith(e));
  if (!ok) throw new Error(`Expected ${allowed.join(", ")} but got "${file.name}"`);
}

function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: (err) => reject(err),
    });
  });
}

async function readWorkbook(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  return XLSX.read(data, { type: "array" });
}

function findHeaderRow(ws, expectedHeaders) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = (rows[i] || []).map((x) => String(x ?? "").toLowerCase());
    const hits = expectedHeaders.filter((h) => r.includes(String(h).toLowerCase())).length;
    if (hits >= Math.ceil(expectedHeaders.length * 0.5)) return i;
  }
  return 0;
}

// ---------- app ----------
export default function App() {
  const rootRef = useRef(null);
  const [status, setStatus] = useState("");

  const [costData, setCostData] = useState([]);
  const [salesMap, setSalesMap] = useState({});
  const [customerData, setCustomerData] = useState([]);
  const [supplierData, setSupplierData] = useState({ suppliers: [], lineItems: [] });

  // thresholds
  const [slowCost, setSlowCost] = useState(400);
  const [deadCost, setDeadCost] = useState(200);
  const [slowDays, setSlowDays] = useState(180);
  const [targetMargin, setTargetMargin] = useState(0.30);
  const [orderingCost, setOrderingCost] = useState(50);
  const [holdingCostRate, setHoldingCostRate] = useState(0.25);

  const metrics = useMemo(() => {
    if (!costData.length) return { avgMargin: 32.21, totalProfit: 5446368.847, totalRevenue: 14444187.626, losingItems: 367 };
    const margins = costData.map((i) => Number(i.profitMargin) || 0);
    const avgMargin = avg(margins);
    const totalProfit = sum(costData.map((i) => Number(i.totalProfit) || 0));
    const totalRevenue = sum(costData.map((i) => Number(i.totalRevenue) || 0));
    const losingItems = costData.filter((i) => (Number(i.profitMargin) || 0) < 0).length;
    return { avgMargin, totalProfit, totalRevenue, losingItems };
  }, [costData]);

  // recompute inventory + predictive whenever inputs change
  const computed = useMemo(() => {
    if (!costData.length) return null;
    const items = costData.map((item) => {
      const code = item.itemCode;
      const s = salesMap[code] || salesMap[`${code}-New`] || salesMap[`${code}-ReCert`] || salesMap[item.fullItem] || null;
      const annualSales = s ? Number(s.totalQtySold) : 0;
      const dailySales = annualSales / 365;
      const daysOfInventory = dailySales > 0 ? Number(item.Quantity) / dailySales : Infinity;

      const leadTimeDays = item.itemType === "ReCert" ? 28 : 21;
      const safetyStock = dailySales * Math.max(7, Math.round(leadTimeDays/2));
      const reorderPoint = (dailySales * leadTimeDays) + safetyStock;
      const daysUntilStockout = dailySales > 0 ? Number(item.Quantity) / dailySales : Infinity;

      const holdingCost = Number(item.unitCost) * holdingCostRate;
      const eoq = (holdingCost > 0 && annualSales > 0) ? Math.round(Math.sqrt((2 * annualSales * orderingCost) / holdingCost)) : Math.round((annualSales/12) * 3);

      const targetPrice = Number(item.unitCost) > 0 ? Number(item.unitCost) / (1 - targetMargin) : 0;
      const priceDelta = Math.max(0, targetPrice - Number(item.unitPrice));
      const annualImpact = priceDelta * annualSales;

      return { ...item, annualSales, dailySales, daysOfInventory, reorderPoint, daysUntilStockout, eoq, priceDelta, annualImpact };
    });

    const slowMovers = items
      .filter((it) => it.totalCost > slowCost && (it.daysOfInventory > slowDays || it.annualSales === 0) && it.Quantity > 0)
      .sort((a, b) => b.totalCost - a.totalCost);

    const deadStock = items
      .filter((it) => it.annualSales === 0 && it.totalCost > deadCost && it.Quantity > 0)
      .sort((a, b) => b.totalCost - a.totalCost);

    const criticalStockouts = items
      .filter((it) => it.daysUntilStockout <= 30 && it.daysUntilStockout !== Infinity && it.totalCost > 1000)
      .sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);

    const warningStockouts = items
      .filter((it) => it.daysUntilStockout > 30 && it.daysUntilStockout <= 60 && it.totalCost > 500)
      .sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);

    const priceOpps = items
      .filter((it) => it.priceDelta > 0 && it.annualSales > 0 && it.totalRevenue > 5000)
      .sort((a, b) => b.annualImpact - a.annualImpact);

    return { items, slowMovers, deadStock, criticalStockouts, warningStockouts, priceOpps };
  }, [costData, salesMap, slowCost, deadCost, slowDays, targetMargin, orderingCost, holdingCostRate]);

  // ---------- file handlers ----------
  async function handleCost(file) {
    ensureExt(file, [".csv"]);
    setStatus("Processing cost CSV...");
    const rows = await parseCSV(file);
    const items = rows
      .filter((row) => pick(row, ["Average Item Rate"]) != null && pick(row, ["Average of Est. Unit Cost"]) != null)
      .map((row) => {
        const fullItem = String(pick(row, ["Item"]) || "");
        const unitPrice = Number(pick(row, ["Average Item Rate"])) || 0;
        const unitCost = Number(pick(row, ["Average of Est. Unit Cost"])) || 0;
        const qty = Number(pick(row, ["Quantity", "Qty"])) || 0;
        const profitPerUnit = unitPrice > 0 ? unitPrice - unitCost : 0;
        const profitMargin = unitPrice > 0 ? ((unitPrice - unitCost) / unitPrice) * 100 : 0;
        return {
          fullItem,
          itemCode: fullItem ? fullItem.split(" : ")[0] : "",
          itemType: /ReCert/i.test(fullItem) ? "ReCert" : "New",
          unitPrice, unitCost, Quantity: qty,
          profitPerUnit, profitMargin,
          totalProfit: profitPerUnit * qty,
          totalRevenue: unitPrice * qty,
          totalCost: unitCost * qty,
        };
      });
    setCostData(items);
    setStatus("✅ Cost data loaded");
  }

  async function handleSales(file) {
    if (file.name.toLowerCase().endsWith(".csv")) {
      setStatus("Processing sales CSV...");
      const rows = await parseCSV(file);
      const byItem = {};
      for (const row of rows) {
        const item = String(pick(row, ["Item", "Inventory Item", "Item Name"]) || "").trim();
        const qty = Number(pick(row, ["Qty", "QtySold", "Quantity", "Quantity Sold"])) || 0;
        const revenue = Number(pick(row, ["TotalRevenue", "Amount", "Total", "Net Amount", "Sales Amount"])) || 0;
        const desc = String(pick(row, ["Description", "ItemDesc", "Name", "Memo"]) || "");
        if (item && qty > 0 && item !== "Inventory Item") {
          if (!byItem[item]) byItem[item] = { item, description: desc, totalQtySold: 0, totalRevenue: 0 };
          byItem[item].totalQtySold += qty;
          byItem[item].totalRevenue += revenue;
        }
      }
      setSalesMap(byItem);
      setStatus("✅ Sales data loaded");
      return;
    }
    // XLS/XLSX
    setStatus("Processing sales XLS/XLSX...");
    const wb = await readWorkbook(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const hdr = findHeaderRow(ws, ["item","qty","quantity","amount","total","description"]);
    const raw = XLSX.utils.sheet_to_json(ws, { range: hdr, header: 1, raw: true, defval: "" });
    const header = (raw[0] || []).map((h) => String(h || "").trim());
    const idx = {
      item: findCol(header, ["Item", "Inventory Item", "Item Name", "Product"]),
      desc: findCol(header, ["Description", "ItemDesc", "Name", "Memo"]),
      qty: findCol(header, ["Qty", "QtySold", "Quantity", "Quantity Sold"]),
      rev: findCol(header, ["TotalRevenue", "Amount", "Total", "Net Amount", "Sales Amount"]),
    };
    const byItem = {};
    for (const r of raw.slice(1)) {
      const item = String(r[idx.item] || "").trim();
      const qty = Number(r[idx.qty] || 0);
      const revenue = Number(r[idx.rev] || 0);
      const desc = String(r[idx.desc] || "");
      if (item && qty > 0 && item !== "Inventory Item") {
        if (!byItem[item]) byItem[item] = { item, description: desc, totalQtySold: 0, totalRevenue: 0 };
        byItem[item].totalQtySold += qty;
        byItem[item].totalRevenue += revenue;
      }
    }
    setSalesMap(byItem);
    setStatus("✅ Sales data loaded");
  }

  async function handleCustomer(file) {
    if (file.name.toLowerCase().endsWith(".csv")) {
      setStatus("Processing customer CSV...");
      const rows = await parseCSV(file);
      const totals = rows
        .map((r) => ({ customer: String(pick(r, ["Customer","Name"]) || ""), amount: Number(pick(r, ["Total","Amount","Net Amount","TotalRevenue"]) || 0) }))
        .filter((r) => /^total - /i.test(r.customer) && r.amount > 0)
        .map((r) => ({ customer: r.customer.replace(/^total - /i, ""), totalRevenue: r.amount }))
        .filter((c) => !/ic-|intercompany|inter-company/i.test(c.customer))
        .sort((a, b) => b.totalRevenue - a.totalRevenue);
      setCustomerData(totals);
      setStatus("✅ Customer data loaded");
      return;
    }
    setStatus("Processing customer XLS/XLSX...");
    const wb = await readWorkbook(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const hdr = findHeaderRow(ws, ["customer","amount","total","net amount"]);
    const raw = XLSX.utils.sheet_to_json(ws, { range: hdr, header: 1, raw: true, defval: "" });
    const header = (raw[0] || []).map((h) => String(h || "").trim());
    const iCustomer = findCol(header, ["Customer","Name"]);
    const iAmount = findCol(header, ["Total","Amount","Net Amount","TotalRevenue"]);
    const totals = raw.slice(1)
      .map((r) => ({ customer: String(r[iCustomer] || ""), amount: Number(r[iAmount] || 0) }))
      .filter((r) => /^total - /i.test(r.customer) && r.amount > 0)
      .map((r) => ({ customer: r.customer.replace(/^total - /i, ""), totalRevenue: r.amount }))
      .filter((c) => !/ic-|intercompany|inter-company/i.test(c.customer))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
    setCustomerData(totals);
    setStatus("✅ Customer data loaded");
  }

  async function handleSupplier(file) {
    if (file.name.toLowerCase().endsWith(".csv")) {
      setStatus("Processing supplier CSV...");
      const rows = await parseCSV(file);
      const supplierTotals = rows
        .map((r) => ({ vendor: String(pick(r, ["Vendor","Supplier","Name"]) || ""), total: Number(pick(r, ["TotalCost","Amount","Total","Net Amount"]) || 0), qty: Number(pick(r, ["Quantity","Qty"]) || 0)}))
        .filter((r) => /^total - /i.test(r.vendor) && r.total > 0)
        .map((r) => ({ supplier: r.vendor.replace(/^total - /i, ""), totalCost: r.total, totalQuantity: r.qty || 0 }))
        .filter((s) => s.totalCost > 0 && !/internal|intercompany/i.test(s.supplier))
        .sort((a, b) => b.totalCost - a.totalCost);

      const lineItems = rows
        .map((r) => ({ supplier: String(pick(r, ["Vendor","Supplier","Name"]) || ""), item: String(pick(r, ["Item","Item Name","Product"]) || ""), totalCost: Number(pick(r, ["TotalCost","Amount","Total","Net Amount"]) || 0), quantity: Number(pick(r, ["Quantity","Qty"]) || 0), date: pick(r, ["Date"]) }))
        .filter((r) => r.supplier && !/^total - /i.test(r.supplier) && r.item && r.totalCost > 0);

      setSupplierData({ suppliers: supplierTotals, lineItems });
      setStatus("✅ Supplier data loaded");
      return;
    }
    setStatus("Processing supplier XLS/XLSX...");
    const wb = await readWorkbook(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const hdr = findHeaderRow(ws, ["vendor","supplier","item","quantity","amount","total"]);
    const raw = XLSX.utils.sheet_to_json(ws, { range: hdr, header: 1, raw: true, defval: "" });
    const header = (raw[0] || []).map((h) => String(h || "").trim());
    const iVendor = findCol(header, ["Vendor","Supplier","Name"]);
    const iItem = findCol(header, ["Item","Item Name","Product"]);
    const iTotal = findCol(header, ["TotalCost","Amount","Total","Net Amount"]);
    const iQty = findCol(header, ["Quantity","Qty"]);
    const suppliers = [];
    const lines = [];
    for (const r of raw.slice(1)) {
      const vendor = String(r[iVendor] || "");
      const item = String(r[iItem] || "");
      const total = Number(r[iTotal] || 0);
      const qty = Number(r[iQty] || 0);
      if (/^total - /i.test(vendor) && total > 0) {
        const name = vendor.replace(/^total - /i, "");
        if (total > 0 && !/internal|intercompany/i.test(name)) {
          suppliers.push({ supplier: name, totalCost: total, totalQuantity: qty || 0 });
        }
      } else if (vendor && item && total > 0) {
        lines.push({ supplier: vendor, item, totalCost: total, quantity: qty || 0 });
      }
    }
    suppliers.sort((a,b)=>b.totalCost - a.totalCost);
    setSupplierData({ suppliers, lineItems: lines });
    setStatus("✅ Supplier data loaded");
  }

  function findCol(headerArr, candidates) {
    const lower = headerArr.map((h) => h.toLowerCase());
    for (const c of candidates) {
      const i = lower.indexOf(c.toLowerCase());
      if (i !== -1) return i;
    }
    // contains
    for (let i = 0; i < lower.length; i++) {
      if (candidates.some((c) => lower[i].includes(c.toLowerCase()))) return i;
    }
    return -1;
  }

  function exportPDF() {
    if (!rootRef.current) return;
    const opt = { margin: 0.3, filename: `NetSuite_BI_${new Date().toISOString().slice(0,10)}.pdf`, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: "in", format: "letter", orientation: "portrait" } };
    html2pdf().set(opt).from(rootRef.current).save();
  }

  function downloadCSV(filename, rows) {
    if (!rows || !rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  }

  const defaultTrends = [
    { period: "360d", SO: 74.98, PO: 54.51 },
    { period: "180d", SO: 77.97, PO: 55.32 },
    { period: "90d", SO: 81.11, PO: 57.52 },
    { period: "60d", SO: 83.71, PO: 59.41 },
    { period: "30d", SO: 89.77, PO: 60.7 },
  ];
  const defaultCompare = [
    { period: "360d", NewSO: 75.46, ReSO: 72.62 },
    { period: "180d", NewSO: 76.92, ReSO: 85.33 },
    { period: "90d", NewSO: 79.31, ReSO: 96.26 },
    { period: "60d", NewSO: 80.74, ReSO: 111.5 },
    { period: "30d", NewSO: 87.07, ReSO: 124.23 },
  ];

  const topBottom = useMemo(() => {
    if (!costData.length) return null;
    const sorted = [...costData].sort((a, b) => (b.totalProfit || 0) - (a.totalProfit || 0));
    return { top: sorted.slice(0, 10), bottom: sorted.slice(-10).reverse() };
  }, [costData]);

  return (
    <div className="min-h-screen p-4 sm:p-6" ref={rootRef}>
      <div className="max-w-[1200px] mx-auto space-y-4">
        <header className="text-center text-white">
          <h1 className="text-2xl sm:text-3xl font-semibold drop-shadow">🏢 NetSuite Business Intelligence</h1>
          <p className="opacity-90">Inventory Optimization · Sales Velocity · Customer & Supplier Intelligence · Predictive Analytics</p>
          <p className="text-xs mt-1">📧 Contact Mitch Hunt / Bryan Badilla · Data stays in your browser</p>
        </header>

        <section className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
          <h2 className="font-semibold text-lg mb-2">📥 Upload NetSuite Exports</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <FilePick label="📁 Item Cost (CSV)" accept=".csv" onFile={handleCost} color="bg-orange-500" />
            <FilePick label="📊 Sales by Item (CSV/XLS/XLSX)" accept=".csv,.xls,.xlsx" onFile={handleSales} color="bg-indigo-600" />
            <FilePick label="👥 Sales by Customer Detail (CSV/XLS/XLSX)" accept=".csv,.xls,.xlsx" onFile={handleCustomer} color="bg-purple-600" />
            <FilePick label="🏭 PO Details (CSV/XLS/XLSX)" accept=".csv,.xls,.xlsx" onFile={handleSupplier} color="bg-teal-600" />
          </div>
          <div className="flex flex-wrap gap-2 text-xs mt-3">
            <Badge ok={!!costData.length} label="Item Cost" />
            <Badge ok={!!Object.keys(salesMap).length} label="Sales Data" />
            <Badge ok={!!customerData.length} label="Customer Data" />
            <Badge ok={!!supplierData.suppliers.length} label="Supplier Data" />
          </div>
          <div className="text-sm text-gray-600 mt-2">{status}</div>
        </section>

        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="Average Margin" value={fmtPct(metrics.avgMargin, 2)} />
          <MetricCard label="Total Profit" value={fmtCurrency(metrics.totalProfit)} />
          <MetricCard label="Total Revenue" value={fmtCurrency(metrics.totalRevenue)} />
          <MetricCard label="Items Losing Money" value={fmtInt(metrics.losingItems)} />
        </section>

        <section className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
          <h3 className="font-semibold mb-2">📈 SO & PO Trends Over Time</h3>
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={defaultTrends} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" />
                <YAxis tickFormatter={(v)=>`$${v}`}/>
                <Tooltip formatter={(v)=>fmtCurrency(v)} />
                <Legend />
                <Line type="monotone" dataKey="SO" stroke="#2563eb" strokeWidth={3} dot={false} />
                <Line type="monotone" dataKey="PO" stroke="#dc2626" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
          <h3 className="font-semibold mb-2">🆚 New vs ReCert — Sales Orders</h3>
          <div className="h-72">
            <ResponsiveContainer>
              <BarChart data={defaultCompare} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="period" />
                <YAxis tickFormatter={(v)=>`$${v}`}/>
                <Tooltip formatter={(v)=>fmtCurrency(v)} />
                <Legend />
                <Bar dataKey="NewSO" fill="#16a34a" />
                <Bar dataKey="ReSO" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        {computed && (
          <section className="grid md:grid-cols-2 gap-3">
            <div className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
              <h3 className="font-semibold mb-2">🎯 Top 10 Profit Generators</h3>
              <div className="space-y-2">
                {computed.items
                  .slice() // clone
                  .sort((a,b)=> (b.totalProfit||0)-(a.totalProfit||0))
                  .slice(0,10)
                  .map((i) => (
                    <Insight key={`top-${i.itemCode}`} color="border-emerald-600">
                      <b>{i.itemCode}</b>: {fmtCurrency(Math.abs(i.totalProfit))} profit ({fmtPct(i.profitMargin)}) · {fmtInt(i.Quantity)} qty
                    </Insight>
                  ))}
              </div>
            </div>
            <div className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
              <h3 className="font-semibold mb-2">⚠️ Top 10 Loss Makers</h3>
              <div className="space-y-2">
                {computed.items
                  .slice()
                  .sort((a,b)=> (a.totalProfit||0)-(b.totalProfit||0))
                  .slice(0,10)
                  .map((i) => (
                    <Insight key={`bot-${i.itemCode}`} color="border-red-600">
                      <b>{i.itemCode}</b>: {fmtCurrency(Math.abs(i.totalProfit))} {i.totalProfit < 0 ? "loss" : "profit"} ({fmtPct(i.profitMargin)}) · {fmtInt(i.Quantity)} qty
                    </Insight>
                  ))}
              </div>
            </div>
          </section>
        )}

        {computed && (
          <section className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
            <div className="bg-gradient-to-r from-red-500 to-orange-500 text-white rounded-xl p-4 mb-3">
              <h3 className="font-semibold text-lg">💰 Working Capital Optimization</h3>
              <p>Slow movers value: {fmtCurrency(sum(computed.slowMovers.map((i)=>i.totalCost)))} · Dead stock value: {fmtCurrency(sum(computed.deadStock.map((i)=>i.totalCost)))}</p>
              <p>Conservative target (25%): {fmtCurrency(0.25 * (sum(computed.slowMovers.map((i)=>i.totalCost)) + sum(computed.deadStock.map((i)=>i.totalCost))))}</p>
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <h4 className="font-semibold mb-2">🚨 Top High-Dollar Slow Movers</h4>
                <div className="space-y-2">
                  {computed.slowMovers.slice(0, 15).map((it) => (
                    <Insight key={`slow-${it.itemCode}`} color="border-orange-500">
                      <b>{it.itemCode}</b>: {fmtCurrency(it.totalCost)} · {fmtInt(it.Quantity)} qty @ {fmtCurrency(it.unitCost)} each · {isFinite(it.daysOfInventory) ? `${Math.round(it.daysOfInventory)} days` : "NO SALES"} · {fmtPct(it.profitMargin)} margin
                    </Insight>
                  ))}
                </div>
                <div className="mt-2"><button className="px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => downloadCSV("slow_movers.csv", computed.slowMovers)}>⬇️ Export CSV</button></div>
              </div>
              <div>
                <h4 className="font-semibold mb-2">💀 Dead Stock (No Sales)</h4>
                <div className="space-y-2">
                  {computed.deadStock.slice(0, 15).map((it) => (
                    <Insight key={`dead-${it.itemCode}`} color="border-red-600">
                      <b>{it.itemCode}</b>: {fmtCurrency(it.totalCost)} · {fmtInt(it.Quantity)} qty @ {fmtCurrency(it.unitCost)} each · Zero sales in 12 months
                    </Insight>
                  ))}
                </div>
                <div className="mt-2"><button className="px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => downloadCSV("dead_stock.csv", computed.deadStock)}>⬇️ Export CSV</button></div>
              </div>
            </div>
          </section>
        )}

        {computed && (
          <section className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
            <div className="bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white rounded-xl p-4 mb-3">
              <h3 className="font-semibold text-lg">🔮 Predictive Analytics</h3>
              <p>{computed.criticalStockouts.length} critical stockout risks (≤30 days) · {computed.warningStockouts.length} warnings (31–60 days)</p>
              <p>{computed.priceOpps.length} price optimization opportunities identified</p>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <h4 className="font-semibold mb-2">🚨 Stockout Risk Alerts</h4>
                <div className="space-y-2">
                  {computed.criticalStockouts.slice(0,8).map((it)=>(
                    <Insight key={`crit-${it.itemCode}`} color="border-red-600">
                      <b>CRITICAL: {it.itemCode}</b> · runs out in {Math.round(it.daysUntilStockout)} days · {fmtInt(it.Quantity)} left · ~{(Math.round(it.dailySales * 10) / 10)} /day
                    </Insight>
                  ))}
                  {computed.warningStockouts.slice(0,5).map((it)=>(
                    <Insight key={`warn-${it.itemCode}`} color="border-orange-500">
                      <b>WARNING: {it.itemCode}</b> · runs out in {Math.round(it.daysUntilStockout)} days · {fmtInt(it.Quantity)} left · ~{(Math.round(it.dailySales * 10) / 10)} /day
                    </Insight>
                  ))}
                  {!computed.criticalStockouts.length && !computed.warningStockouts.length && (
                    <Insight color="border-emerald-600"><b>✅ No critical stockout risks detected!</b> All high-value items have sufficient inventory.</Insight>
                  )}
                </div>
              </div>
              <div>
                <h4 className="font-semibold mb-2">💰 Price Optimization</h4>
                <div className="space-y-2">
                  {computed.priceOpps.slice(0,8).map((it)=>(
                    <Insight key={`price-${it.itemCode}`} color="border-purple-600">
                      <b>{it.itemCode}</b>: +{it.priceDelta.toFixed(2)} price headroom · Annual impact: {fmtCurrency(it.annualImpact)}
                    </Insight>
                  ))}
                </div>
                <div className="mt-2"><button className="px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => downloadCSV("price_opportunities.csv", computed.priceOpps)}>⬇️ Export Price Opps CSV</button></div>
              </div>
            </div>
          </section>
        )}

        <section className="bg-white/95 rounded-2xl p-4 shadow border border-white/30">
          <h3 className="font-semibold mb-2">📄 Export & Utilities</h3>
          <div className="flex flex-wrap gap-2">
            <button className="px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700" onClick={exportPDF}>📄 Export PDF</button>
            <button className="px-3 py-2 rounded-lg bg-gray-800 text-white hover:bg-gray-900" onClick={()=>window.print()}>🖨️ Print</button>
          </div>
        </section>

        <footer className="text-center text-white/90 text-xs pb-6">Data stays in your browser · {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</footer>
      </div>
    </div>
  );
}

// ---- UI helpers ----
function MetricCard({ label, value }) {
  return (
    <div className="bg-white/95 rounded-2xl p-4 shadow border border-white/30 text-center hover:-translate-y-0.5 transition-transform">
      <div className="text-2xl font-bold text-gray-800">{value}</div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mt-1">{label}</div>
    </div>
  );
}
function FilePick({ label, accept, onFile, color="bg-blue-600" }) {
  const ref = useRef(null);
  return (
    <div className="flex items-stretch gap-2">
      <button type="button" className={`text-white ${color} hover:opacity-90 px-3 py-2 rounded-lg w-full`} onClick={() => ref.current?.click()}>{label}</button>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e)=>e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}
function Badge({ ok, label }) {
  return <span className={`px-2 py-1 rounded text-xs font-semibold ${ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{label}: {ok ? "Loaded" : "Not Loaded"}</span>;
}
function Insight({ children, color="border-blue-500" }) {
  return <div className={`border-l-4 ${color} bg-gray-50 rounded-md px-3 py-2 text-sm`}>{children}</div>;
}