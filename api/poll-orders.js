const DEFAULT_NOTIFICATION_CUTOFF = "2026-08-19T00:00:00Z";

async function getLuluToken(key, secret) {
  const basicAuth = Buffer.from(`${key}:${secret}`).toString("base64");
  const response = await fetch("https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Failed to get Lulu production token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} from ${url}: ${JSON.stringify(data)}`);
  return data;
}

function normalizeDashboardStatus(rawStatus) {
  const status = String(rawStatus || "").trim().toUpperCase();
  if (!status) return "CREATED";
  if (status.includes("CANCEL")) return "CANCELLED";
  if (status.includes("SHIP")) return "SHIPPED";
  if (
    status.includes("PRINT") ||
    status.includes("PRODUCTION") ||
    status === "IN_PRODUCTION" ||
    status === "PRODUCTION_DELAYED" ||
    status === "PRODUCTION_DELAY"
  ) return "PRINTING";
  if (status === "UNPAID" || status === "CREATED" || status === "ACCEPTED") return "CREATED";
  return "CREATED";
}

function extractTracking(printData, statusData) {
  const statusLineItems = statusData?.line_item_statuses || [];
  for (const itemStatus of statusLineItems) {
    const messages = itemStatus?.messages || {};
    const trackingId = messages?.tracking_id || "";
    const urls = messages?.tracking_urls || [];
    if (trackingId || (Array.isArray(urls) && urls.length)) return { trackingId, trackingUrl: Array.isArray(urls) ? urls.join(", ") : String(urls || "") };
  }
  const lineItems = printData?.line_items || [];
  for (const lineItem of lineItems) {
    const messages = lineItem?.status?.messages || {};
    const trackingId = lineItem?.tracking_id || messages?.tracking_id || "";
    const urls = lineItem?.tracking_urls || messages?.tracking_urls || [];
    if (trackingId || (Array.isArray(urls) && urls.length)) return { trackingId, trackingUrl: Array.isArray(urls) ? urls.join(", ") : String(urls || "") };
  }
  return { trackingId: "", trackingUrl: "" };
}

async function updateGoogleSheet(sheetUrl, payload) {
  const response = await fetch(sheetUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheets update failed (${response.status}): ${text}`);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  if (parsed?.ok === false) throw new Error(`Google Sheets update failed: ${text}`);
  return parsed;
}

async function loadPrintJob(accessToken, luluJobId) {
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const printData = await fetchJson(`https://api.lulu.com/print-jobs/${encodeURIComponent(luluJobId)}/`, { headers });
  let statusData = printData?.status || {};
  try { statusData = await fetchJson(`https://api.lulu.com/print-jobs/${encodeURIComponent(luluJobId)}/status/`, { headers }); }
  catch (error) { console.warn(`Status endpoint failed for Lulu job ${luluJobId}:`, error.message); }
  return { printData, statusData };
}

function buildSheetPayload(printData, statusData, fallbackExternalId) {
  const lineItem = printData?.line_items?.[0] || {};
  const shippingAddress = printData?.shipping_address || {};
  const tracking = extractTracking(printData, statusData);
  const shippingDates = printData?.estimated_shipping_dates || {};
  const rawStatus = statusData?.name || printData?.status?.name || "";

  const costs = printData?.costs || {};
  const shippingCost = costs?.shipping_cost || {};
  const lineItemCost = costs?.line_item_costs?.[0] || {};

  return {
    luluJobId: printData?.id || "",
    externalId: printData?.external_id || fallbackExternalId || "",
    product: lineItem?.title || "",
    quantity: lineItem?.quantity || "",
    customerEmail: printData?.contact_email || "",
    status: normalizeDashboardStatus(rawStatus),
    shippingLevel: printData?.shipping_level || printData?.shipping_option_level || "",
    printCostExclTax: lineItemCost?.total_cost_excl_tax || "",
    printCostInclTax: lineItemCost?.total_cost_incl_tax || "",
    shippingCostExclTax: shippingCost?.total_cost_excl_tax || "",
    shippingCostInclTax: shippingCost?.total_cost_incl_tax || "",
    totalCostExclTax: costs?.total_cost_excl_tax || "",
    totalCostInclTax: costs?.total_cost_incl_tax || "",
    currency: costs?.currency || "",
    trackingId: tracking.trackingId,
    trackingUrl: tracking.trackingUrl,
    recipientName: shippingAddress?.name || "",
    address1: shippingAddress?.street1 || "",
    address2: shippingAddress?.street2 || "",
    city: shippingAddress?.city || "",
    stateCode: shippingAddress?.state_code || "",
    postcode: shippingAddress?.postcode || "",
    countryCode: shippingAddress?.country_code || "",
    phone: shippingAddress?.phone_number || "",
    productionDueTime: printData?.production_due_time || "",
    estimatedProductionDate: "",
    estimatedShipDate: shippingDates?.dispatch_max || "",
    estimatedShipDateMin: shippingDates?.dispatch_min || "",
    estimatedShipDateMax: shippingDates?.dispatch_max || "",
    estimatedArrivalDateMin: shippingDates?.arrival_min || "",
    estimatedArrivalDateMax: shippingDates?.arrival_max || "",
    notes: `Lulu raw status: ${rawStatus}. ${statusData?.message || printData?.status?.message || ""}`.trim()
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    const key = process.env.LULU_CLIENT_KEY;
    const secret = process.env.LULU_CLIENT_SECRET;
    const sheetUrl = process.env.GSHEET_URL || process.env.GOOGLE_SHEETS_LOGGER_URL;
    if (!key || !secret) return res.status(500).json({ error: "Missing Lulu production credentials" });
    if (!sheetUrl) return res.status(500).json({ error: "Missing Google Sheets URL" });
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || "";
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) return res.status(401).json({ error: "Unauthorized" });
    const accessToken = await getLuluToken(key, secret);
    const { printJobId, externalId, dryRun } = req.query || {};
    if (printJobId) {
      const { printData, statusData } = await loadPrintJob(accessToken, printJobId);
      const payload = buildSheetPayload(printData, statusData, externalId);
      let sheetResult = null;
      if (String(dryRun || "") !== "1") sheetResult = await updateGoogleSheet(sheetUrl, payload);
      return res.status(200).json({ ok: true, mode: "production", dryRun: String(dryRun || "") === "1", payload, sheetResult, luluResponse: printData, luluStatus: statusData });
    }
    const pendingData = await fetchJson(`${sheetUrl}?action=pending`);
    const pendingOrders = Array.isArray(pendingData?.orders) ? pendingData.orders : [];
    const cutoffString = process.env.DMOS_NOTIFICATIONS_START_DATE || DEFAULT_NOTIFICATION_CUTOFF;
    const cutoff = new Date(cutoffString);
    const results = [];
    for (const order of pendingOrders) {
      const luluJobId = String(order?.luluJobId || "").trim();
      const fallbackExternalId = String(order?.externalId || "").trim();
      if (!/^\d+$/.test(luluJobId)) { results.push({ luluJobId, skipped: true, reason: "invalid Lulu job id" }); continue; }
      try {
        const { printData, statusData } = await loadPrintJob(accessToken, luluJobId);
        const created = printData?.date_created ? new Date(printData.date_created) : null;
        if (created && !Number.isNaN(created.getTime()) && !Number.isNaN(cutoff.getTime()) && created < cutoff) {
          results.push({ luluJobId, externalId: printData?.external_id || fallbackExternalId, status: normalizeDashboardStatus(statusData?.name || printData?.status?.name || ""), skipped: true, reason: `created before notification cutoff ${cutoffString}` });
          continue;
        }
        const payload = buildSheetPayload(printData, statusData, fallbackExternalId);
        const sheetResult = await updateGoogleSheet(sheetUrl, payload);
        results.push({ luluJobId, externalId: payload.externalId, status: payload.status, totalCostInclTax: payload.totalCostInclTax, productionDueTime: payload.productionDueTime, estimatedShipDateMin: payload.estimatedShipDateMin, estimatedShipDateMax: payload.estimatedShipDateMax, hasTracking: Boolean(payload.trackingId || payload.trackingUrl), updated: true, sheetResult });
      } catch (error) { results.push({ luluJobId, externalId: fallbackExternalId, updated: false, error: error.message }); }
    }
    return res.status(200).json({ ok: true, mode: "production", notificationCutoff: cutoffString, ordersChecked: pendingOrders.length, results });
  } catch (error) {
    console.error("poll-orders fatal error:", error);
    return res.status(500).json({ error: "Unexpected server error", details: error.message });
  }
}
