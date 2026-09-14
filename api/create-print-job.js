console.log("🔥 NEW VERSION DEPLOYED 🔥");

async function logToGoogleSheets(payload) {
  const loggerUrl = process.env.GOOGLE_SHEETS_LOGGER_URL;
  if (!loggerUrl) {
    console.warn("GOOGLE_SHEETS_LOGGER_URL is not set");
    return { ok: false, error: "GOOGLE_SHEETS_LOGGER_URL is not set" };
  }
  try {
    const response = await fetch(loggerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    console.log("Google Sheets logger response:", text);
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    console.error("Failed to log to Google Sheets:", error.message);
    return { ok: false, error: error.message };
  }
}

function firstTrackingInfo(printData) {
  const lineItems = printData?.line_items || [];
  for (const lineItem of lineItems) {
    const statusMessages = lineItem?.status?.messages || {};
    const trackingId = lineItem?.tracking_id || statusMessages?.tracking_id || "";
    const rawTrackingUrls = lineItem?.tracking_urls || statusMessages?.tracking_urls || [];
    const trackingUrl = Array.isArray(rawTrackingUrls) ? rawTrackingUrls.join(", ") : String(rawTrackingUrls || "");
    if (trackingId || trackingUrl) return { trackingId, trackingUrl };
  }
  return { trackingId: "", trackingUrl: "" };
}

function sumCost(costItems, field) {
  let sawValue = false;
  let total = 0;
  for (const item of costItems || []) {
    const value = item?.[field];
    if (value !== undefined && value !== null && value !== "") {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        total += numeric;
        sawValue = true;
      }
    }
  }
  return sawValue ? total.toFixed(2) : "";
}

function summarizeLineItems(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  return {
    product: items.map((item) => item?.title || "").filter(Boolean).join(" + "),
    quantity: items.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0)
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const key = process.env.LULU_CLIENT_KEY;
    const secret = process.env.LULU_CLIENT_SECRET;
    const luluContactEmail = process.env.LULU_CONTACT_EMAIL || "letsgo@domoreonshore.com";
    const defaultPhone = process.env.DEFAULT_PHONE_NUMBER || "6515555555";

    if (!key || !secret) return res.status(500).json({ error: "Missing Lulu production credentials" });

    const {
      sku,
      quantity = 1,
      items,
      shippingLevel = "MAIL",
      externalId,
      squarespaceOrderNumber,
      contactEmail: customerEmail,
      shippingAddress = {}
    } = req.body || {};

    if (!externalId) return res.status(400).json({ error: "Missing externalId" });

    const requestedItems = Array.isArray(items) && items.length
      ? items
      : (sku ? [{ sku, quantity }] : []);

    if (!requestedItems.length) {
      return res.status(400).json({ error: "Missing items" });
    }

    const SKU_TO_LULU = {
      "PR-ARCH-BOOK-01": {
        title: "Architecture of Puerto Rico: A Coloring Book Adventure",
        interiorPdfUrl: "https://drive.google.com/uc?export=download&id=1388sIZ95d7p67Sxmys_MyDya-aNh-XI1",
        coverUrl: "https://drive.google.com/uc?export=download&id=1SiJ_XBQ6zqUuWJf79DgNk7unXGDMKC5l",
        podPackageId: "0850X1100BWSTDPB080CW444MXX",
        pageCount: 48
      },
      "BE-PR-1.1": {
        title: "Beaches of Puerto Rico: A Coloring Book Adventure",
        interiorPdfUrl: "https://drive.google.com/uc?export=download&id=1NtIbF_ghUggIEKsTsD8_tLqF8lptUx1X",
        coverUrl: "https://drive.google.com/uc?export=download&id=1HSWyCvkwyrEs-UBh-Dw8Bf_KeXW06G90",
        podPackageId: "0850X1100BWSTDPB080CW444MXX",
        pageCount: 61
      }
    };

    const normalizedItems = requestedItems.map((item) => {
      const itemSku = String(item?.sku || "").trim();
      const itemQuantity = Number(item?.quantity) || 1;
      const mapping = SKU_TO_LULU[itemSku];

      if (!mapping) {
        const error = new Error(`No Lulu mapping found for sku: ${itemSku}`);
        error.statusCode = 400;
        throw error;
      }
      if (!mapping.interiorPdfUrl || !mapping.coverUrl || !mapping.podPackageId) {
        const error = new Error(`Incomplete SKU mapping for sku: ${itemSku}`);
        error.statusCode = 500;
        throw error;
      }

      return { sku: itemSku, quantity: itemQuantity, mapping };
    });

    const finalShippingAddress = {
      name: shippingAddress.name || "Test Customer",
      street1: shippingAddress.street1 || "",
      street2: shippingAddress.street2 || "",
      city: shippingAddress.city || "",
      state_code: shippingAddress.state || shippingAddress.state_code || "",
      postcode: shippingAddress.zip || shippingAddress.postcode || "",
      country_code: (shippingAddress.country || shippingAddress.country_code || "US").toUpperCase(),
      phone_number: shippingAddress.phone || shippingAddress.phone_number || defaultPhone
    };

    if (!finalShippingAddress.name || !finalShippingAddress.street1 || !finalShippingAddress.city || !finalShippingAddress.postcode || !finalShippingAddress.country_code || !finalShippingAddress.phone_number) {
      return res.status(400).json({ error: "Missing required shipping address fields" });
    }

    const basicAuth = Buffer.from(`${key}:${secret}`).toString("base64");
    const authResponse = await fetch("https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });
    const authData = await authResponse.json();
    if (!authResponse.ok || !authData.access_token) return res.status(500).json({ error: "Failed to get Lulu production token", details: authData });

    const printJobPayload = {
      contact_email: luluContactEmail,
      external_id: String(externalId),
      production_delay: 120,
      shipping_level: shippingLevel,
      shipping_address: finalShippingAddress,
      line_items: normalizedItems.map((item, index) => ({
        external_id: `${externalId}-item-${index + 1}`,
        title: item.mapping.title,
        quantity: item.quantity,
        printable_normalization: {
          pod_package_id: item.mapping.podPackageId,
          cover: { source_url: item.mapping.coverUrl },
          interior: { source_url: item.mapping.interiorPdfUrl }
        }
      }))
    };

    const printResponse = await fetch("https://api.lulu.com/print-jobs/", {
      method: "POST",
      headers: { Authorization: `Bearer ${authData.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(printJobPayload)
    });
    const printData = await printResponse.json();
    if (!printResponse.ok) return res.status(printResponse.status).json({ error: "Failed to create Lulu print job", details: printData, requestPayload: printJobPayload });

    const costs = printData?.costs || {};
    const shippingCost = costs?.shipping_cost || {};
    const lineItemCosts = costs?.line_item_costs || [];
    const tracking = firstTrackingInfo(printData);
    const summary = summarizeLineItems(printData?.line_items || printJobPayload.line_items);

    const loggerResult = await logToGoogleSheets({
      squarespaceOrder: squarespaceOrderNumber || externalId,
      luluJobId: printData?.id || "",
      externalId: printData?.external_id || externalId,
      product: summary.product,
      quantity: summary.quantity,
      customerEmail: customerEmail || "",
      status: printData?.status?.name || "",
      shippingLevel: printData?.shipping_level || shippingLevel || "",
      printCostExclTax: sumCost(lineItemCosts, "total_cost_excl_tax"),
      printCostInclTax: sumCost(lineItemCosts, "total_cost_incl_tax"),
      shippingCostExclTax: shippingCost?.total_cost_excl_tax || "",
      shippingCostInclTax: shippingCost?.total_cost_incl_tax || "",
      totalCostExclTax: costs?.total_cost_excl_tax || "",
      totalCostInclTax: costs?.total_cost_incl_tax || "",
      currency: costs?.currency || "",
      trackingId: tracking.trackingId,
      trackingUrl: tracking.trackingUrl,
      recipientName: finalShippingAddress?.name || "",
      address1: finalShippingAddress?.street1 || "",
      address2: finalShippingAddress?.street2 || "",
      city: finalShippingAddress?.city || "",
      stateCode: finalShippingAddress?.state_code || "",
      postcode: finalShippingAddress?.postcode || "",
      countryCode: finalShippingAddress?.country_code || "",
      phone: finalShippingAddress?.phone_number || "",
      estimatedProductionDate: printData?.production_due_time || "",
      estimatedShipDate: printData?.estimated_shipping_dates?.dispatch_max || "",
      notes: normalizedItems.length > 1 ? "Initial create-print-job log; multi-book order" : "Initial create-print-job log"
    });

    return res.status(200).json({ ok: true, mode: "production", requestPayload: printJobPayload, luluResponse: printData, loggerResult });
  } catch (error) {
    console.error("create-print-job fatal error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Unexpected server error", details: error.statusCode ? undefined : error.message });
  }
}
