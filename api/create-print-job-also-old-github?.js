async function logToGoogleSheets(payload) {
  const loggerUrl = process.env.GOOGLE_SHEETS_LOGGER_URL;

  if (!loggerUrl) {
    console.warn("GOOGLE_SHEETS_LOGGER_URL is not set");
    return { ok: false, error: "GOOGLE_SHEETS_LOGGER_URL is not set" };
  }

  try {
    const response = await fetch(loggerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log("Google Sheets logger response:", text);

    return {
      ok: response.ok,
      status: response.status,
      text
    };
  } catch (error) {
    console.error("Failed to log to Google Sheets:", error.message);
    return { ok: false, error: error.message };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const key = process.env.LULU_CLIENT_KEY;
    const secret = process.env.LULU_CLIENT_SECRET;
    const contactEmail = process.env.LULU_CONTACT_EMAIL || "n8@domoreonshore.com";
    const defaultPhone = process.env.DEFAULT_PHONE_NUMBER || "6515555555";

return res.status(200).json({
  debug: true,
  keyExists: !!key,
  secretExists: !!secret,
  keyPrefix: key ? key.slice(0, 6) : null,
  secretLength: secret ? secret.length : 0
});

    if (!key || !secret) {
      return res.status(500).json({ error: "Missing Lulu production credentials" });
    }

    const {
      sku,
      quantity = 1,
      shippingLevel = "MAIL",
      externalId,
      contactEmail: requestContactEmail,
      shippingAddress = {}
    } = req.body || {};

    if (!sku) {
      return res.status(400).json({ error: "Missing sku" });
    }

    if (!externalId) {
      return res.status(400).json({ error: "Missing externalId" });
    }

    const SKU_TO_LULU = {
      "PR-ARCH-BOOK-01": {
        title: "Architecture of Puerto Rico: A Coloring Book Adventure",
        interiorPdfUrl: "https://drive.google.com/uc?export=download&id=1388sIZ95d7p67Sxmys_MyDya-aNh-XI1",
        coverUrl: "https://drive.google.com/uc?export=download&id=1SiJ_XBQ6zqUuWJf79DgNk7unXGDMKC5l",
        podPackageId: "0850X1100BWSTDPB080CW444MXX",
        pageCount: 48
      }
    };

    const mapping = SKU_TO_LULU[sku];

    if (!mapping) {
      return res.status(400).json({ error: `No Lulu mapping found for sku: ${sku}` });
    }

    if (!mapping.interiorPdfUrl || !mapping.coverUrl || !mapping.podPackageId) {
      return res.status(500).json({ error: "Incomplete SKU mapping" });
    }

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

    if (
      !finalShippingAddress.name ||
      !finalShippingAddress.street1 ||
      !finalShippingAddress.city ||
      !finalShippingAddress.postcode ||
      !finalShippingAddress.country_code ||
      !finalShippingAddress.phone_number
    ) {
      return res.status(400).json({
        error: "Missing required shipping address fields"
      });
    }

    const basicAuth = Buffer.from(`${key}:${secret}`).toString("base64");

    const authResponse = await fetch(
      "https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
      }
    );

    const authData = await authResponse.json();

    if (!authResponse.ok || !authData.access_token) {
      return res.status(500).json({
        error: "Failed to get Lulu production token",
        details: authData
      });
    }

    const finalExternalId = externalId;

    const printJobPayload = {
      contact_email: requestContactEmail || contactEmail,
      external_id: String(finalExternalId),
      production_delay: 120,
      shipping_level: shippingLevel,
      shipping_address: finalShippingAddress,
      line_items: [
        {
          external_id: `${finalExternalId}-item-1`,
          title: mapping.title,
          quantity: Number(quantity),
          printable_normalization: {
            pod_package_id: mapping.podPackageId,
            cover: {
              source_url: mapping.coverUrl
            },
            interior: {
              source_url: mapping.interiorPdfUrl
            }
          }
        }
      ]
    };

    const printResponse = await fetch(
      "https://api.lulu.com/print-jobs/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authData.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(printJobPayload)
      }
    );

    const printData = await printResponse.json();

    if (!printResponse.ok) {
      return res.status(printResponse.status).json({
        error: "Failed to create Lulu print job",
        details: printData,
        requestPayload: printJobPayload
      });
    }

    const lineItem = printData?.line_items?.[0] || {};
    const costs = printData?.costs || {};
    const shippingCost = costs?.shipping_cost || {};
    const lineItemCost = costs?.line_item_costs?.[0] || {};

    const loggerResult = await logToGoogleSheets({
      squarespaceOrder: externalId,
      luluJobId: printData?.id || "",
      externalId: printData?.external_id || finalExternalId,
      product: mapping.title || "",
      quantity: lineItem?.quantity || quantity || 1,
      customerEmail: requestContactEmail || contactEmail,
      status: printData?.status?.name || "",
      shippingLevel: printData?.shipping_level || shippingLevel || "",
      printCostExclTax: lineItemCost?.total_cost_excl_tax || "",
      printCostInclTax: lineItemCost?.total_cost_incl_tax || "",
      shippingCostExclTax: shippingCost?.total_cost_excl_tax || "",
      shippingCostInclTax: shippingCost?.total_cost_incl_tax || "",
      totalCostExclTax: costs?.total_cost_excl_tax || "",
      totalCostInclTax: costs?.total_cost_incl_tax || "",
      currency: costs?.currency || "",
      trackingId: lineItem?.tracking_id || "",
      trackingUrl: Array.isArray(lineItem?.tracking_urls) ? lineItem.tracking_urls.join(", ") : "",
      recipientName: finalShippingAddress?.name || "",
      city: finalShippingAddress?.city || "",
      stateCode: finalShippingAddress?.state_code || "",
      postcode: finalShippingAddress?.postcode || "",
      countryCode: finalShippingAddress?.country_code || "",
      notes: "Initial create-print-job log"
    });

    return res.status(200).json({
      ok: true,
      mode: "production",
      requestPayload: printJobPayload,
      luluResponse: printData,
      loggerResult
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected server error",
      details: error.message
    });
  }
}