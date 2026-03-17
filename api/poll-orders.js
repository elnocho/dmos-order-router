export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const key = process.env.LULU_SANDBOX_CLIENT_KEY;
    const secret = process.env.LULU_SANDBOX_CLIENT_SECRET;

    if (!key || !secret) {
      return res.status(500).json({ error: "Missing Lulu sandbox credentials" });
    }

    const { printJobId, externalId } = req.query || {};

    if (!printJobId && !externalId) {
      return res.status(400).json({
        error: "Missing printJobId or externalId query parameter"
      });
    }

    const basicAuth = Buffer.from(`${key}:${secret}`).toString("base64");

    const authResponse = await fetch(
      "https://api.sandbox.lulu.com/auth/realms/glasstree/protocol/openid-connect/token",
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
        error: "Failed to get Lulu sandbox token",
        details: authData
      });
    }

    let url = "";

    if (printJobId) {
      url = `https://api.sandbox.lulu.com/print-jobs/${encodeURIComponent(printJobId)}/`;
    } else {
      url = `https://api.sandbox.lulu.com/print-jobs/?external_id=${encodeURIComponent(externalId)}`;
    }

    const pollResponse = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authData.access_token}`,
        "Content-Type": "application/json"
      }
    });

    const pollData = await pollResponse.json();

    if (!pollResponse.ok) {
      return res.status(pollResponse.status).json({
        error: "Failed to poll Lulu sandbox print job",
        details: pollData
      });
    }

    return res.status(200).json({
      ok: true,
      mode: "sandbox",
      query: { printJobId: printJobId || null, externalId: externalId || null },
      luluResponse: pollData
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected server error",
      details: error.message
    });
  }
}