export default async function handler(req, res) {
  try {
    // Only allow POST
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // ---- Simple token auth ----
    const expected = process.env.DMOS_WEBHOOK_TOKEN;
    const provided =
      req.headers["x-dmos-token"] ||
      req.headers["x-webhook-token"] ||
      req.query.token;

    if (!expected) {
      return res
        .status(500)
        .json({ ok: false, error: "Missing DMOS_WEBHOOK_TOKEN env var" });
    }

    if (provided !== expected) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // ---- Read raw body ----
    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", resolve);
    });

    // ---- Parse JSON body (if possible) ----
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      // leave parsed as null
    }

    // ---- Minimal safe logging (avoid dumping full customer data) ----
    console.log("Squarespace webhook received", {
      contentType: req.headers["content-type"],
      userAgent: req.headers["user-agent"],
      bodyLength: body?.length || 0,
      hasParsedJson: !!parsed,
      topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 25) : [],
    });

    // ---- Lulu auth test (safe) ----
    const key = process.env.LULU_CLIENT_KEY;
    const secret = process.env.LULU_CLIENT_SECRET;

    if (!key || !secret) {
      return res.status(500).json({ ok: false, error: "Missing Lulu env vars" });
    }

    const basicAuth = Buffer.from(`${key}:${secret}`).toString("base64");

    const authResponse = await fetch(
      "https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      }
    );

    const authData = await authResponse.json();

    if (!authResponse.ok) {
      return res.status(500).json({
        ok: false,
        error: "Lulu auth failed",
        details: authData,
      });
    }

    // IMPORTANT: Do NOT return access_token in responses or logs
    return res.status(200).json({
      ok: true,
      luluAuth: "success",
      expires_in: authData.expires_in,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "Server error" });
  }
}