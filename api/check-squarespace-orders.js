async function orderAlreadyProcessed(externalId) {
  const sheetUrl = process.env.GSHEET_URL;

  if (!sheetUrl) {
    throw new Error("Missing GSHEET_URL environment variable");
  }

  const checkUrl = `${sheetUrl}?externalId=${encodeURIComponent(externalId)}`;

  const res = await fetch(checkUrl);
  const data = await res.json();

  if (!res.ok || !data.ok) {
    throw new Error(`Google Sheets check failed: ${JSON.stringify(data)}`);
  }

  return data.found === true;
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.SQUARESPACE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "Missing Squarespace API key" });
    }

    if (!process.env.GSHEET_URL) {
      return res.status(500).json({ error: "Missing GSHEET_URL environment variable" });
    }

    const baseUrl =
      process.env.APP_BASE_URL || "https://dmos-order-router-git.vercel.app";

    const response = await fetch(
      "https://api.squarespace.com/1.0/commerce/orders?limit=50",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "DMOS Order Router"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "Failed to fetch Squarespace orders",
        details: data
      });
    }

    const orders = data.result || [];
    const processed = [];

    for (const order of orders) {
      const externalId = order.id;
      const lineItems = order.lineItems || [];

      const hasMatchingSku = lineItems.some(
        (item) => item.sku === "PR-ARCH-BOOK-01"
      );

      if (!hasMatchingSku) {
        continue;
      }

      const alreadyProcessed = await orderAlreadyProcessed(externalId);

      if (alreadyProcessed) {
        processed.push({
          orderId: externalId,
          skipped: true,
          reason: "already processed"
        });
        continue;
      }

      for (const item of lineItems) {
        if (item.sku !== "PR-ARCH-BOOK-01") {
          continue;
        }

        const raw = order.shippingAddress || {};

        const fullName =
          raw.name ||
          `${raw.firstName || ""} ${raw.lastName || ""}`.trim() ||
          "Test Customer";

        const payload = {
          sku: "PR-ARCH-BOOK-01",
          quantity: item.quantity,
          contactEmail: order.customerEmail || "",
          externalId,
          shippingAddress: {
            name: fullName,
            street1: raw.address1 || "",
            street2: raw.address2 || "",
            city: raw.city || "",
            state: raw.state || "",
            zip: raw.postalCode || raw.zip || "",
            country: raw.countryCode || raw.country || "US",
            phone: raw.phone || "0000000000"
          }
        };

        const createResponse = await fetch(
          `${baseUrl}/api/create-print-job`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          }
        );

        const result = await createResponse.json();

        processed.push({
          orderId: externalId,
          skipped: false,
          payloadSent: payload,
          debugShipping: {
            shippingAddressRaw: order.shippingAddress || null,
            billingAddressRaw: order.billingAddress || null
          },
          result
        });
      }
    }

    return res.status(200).json({
      ok: true,
      baseUrlUsed: baseUrl,
      createPrintJobUrl: `${baseUrl}/api/create-print-job`,
      ordersChecked: orders.length,
      processed
    });
  } catch (error) {
    return res.status(500).json({
      error: "Squarespace order check failed",
      details: error.message
    });
  }
}