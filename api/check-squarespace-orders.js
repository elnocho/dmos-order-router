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

    const response = await fetch(
      "https://api.squarespace.com/1.0/commerce/orders?limit=10",
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
      const lineItems = order.lineItems || [];

      const hasMatchingSku = lineItems.some(
        (item) => item.sku === "PR-ARCH-BOOK-01"
      );

      if (!hasMatchingSku) {
        continue;
      }

      const alreadyProcessed = await orderAlreadyProcessed(order.id);

      if (alreadyProcessed) {
        console.log(`Skipping ${order.id} - already processed`);
        processed.push({
          orderId: order.id,
          skipped: true,
          reason: "already processed"
        });
        continue;
      }

      for (const item of lineItems) {
        if (item.sku !== "PR-ARCH-BOOK-01") {
          continue;
        }

        const payload = {
          sku: "PR-ARCH-BOOK-01",
          quantity: item.quantity,
          contactEmail: order.customerEmail || "",
          externalId: order.id,
          shippingAddress: {
            name: order.shippingAddress?.name || "",
            street1: order.shippingAddress?.address1 || "",
            street2: order.shippingAddress?.address2 || "",
            city: order.shippingAddress?.city || "",
            state: order.shippingAddress?.state || "",
            zip: order.shippingAddress?.postalCode || "",
            country: order.shippingAddress?.country || "US",
            phone: order.billingAddress?.phone || "0000000000"
          }
        };

const baseUrl = process.env.APP_BASE_URL || "https://dmos-order-router-git.vercel.app";

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
          orderId: order.id,
          skipped: false,
          result
        });
      }
    }

    return res.status(200).json({
      ok: true,
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