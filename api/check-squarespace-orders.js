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

    // ✅ DEFINE BASE URL HERE (GLOBAL TO HANDLER)
    const baseUrl =
      process.env.APP_BASE_URL ||
      "https://dmos-order-router-git.vercel.app";

    const response = await fetch(
      "https://api.squarespace.com/1.0/commerce/orders?limit=10",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": "DMOS Order Router",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({
        error: "Failed to fetch Squarespace orders",
        details: data,
      });
    }

    const orders = data.result || [];
    const processed = [];

    for (const order of orders) {
      const externalId = order.id;

      try {
        // ✅ Skip if already processed
        const alreadyProcessed = await orderAlreadyProcessed(externalId);

        if (alreadyProcessed) {
          processed.push({
            orderId: externalId,
            skipped: true,
            reason: "already processed",
          });
          continue;
        }

        const lineItems = order.lineItems || [];

        for (const item of lineItems) {
          const sku = item.sku;

          // ✅ ONLY PROCESS YOUR PRODUCT
          if (sku !== "PR-ARCH-BOOK-01") continue;

          const payload = {
            externalId,
            productName: item.productName,
            quantity: item.quantity,
            customerEmail: order.customerEmail,
            shippingAddress: order.shippingAddress,
          };

          // ✅ CALL CREATE PRINT JOB
          const createResponse = await fetch(
            `${baseUrl}/api/create-print-job`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            }
          );

          const result = await createResponse.json();

          processed.push({
            orderId: externalId,
            skipped: false,
            result,
          });
        }
      } catch (err) {
        processed.push({
          orderId: externalId,
          skipped: false,
          result: {
            error: err.message,
          },
        });
      }
    }

    // ✅ DEBUG OUTPUT INCLUDED
    return res.status(200).json({
      ok: true,
      baseUrlUsed: baseUrl,
      createPrintJobUrl: `${baseUrl}/api/create-print-job`,
      ordersChecked: orders.length,
      processed,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Squarespace order check failed",
      details: error.message,
    });
  }
}