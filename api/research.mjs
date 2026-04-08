export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "No prompt provided" });
    }

    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const data = await response.json();

      if (data.error && data.error.type === "rate_limit_error") {
        lastError = data.error.message;
        await new Promise((r) => setTimeout(r, (attempt + 1) * 20000));
        continue;
      }

      if (data.error) {
        return res.status(502).json({ error: data.error.message });
      }

      const textBlocks = data.content?.filter((b) => b.type === "text") || [];
      const text = textBlocks.map((b) => b.text).join("\n");
      return res.status(200).json({ text });
    }

    return res.status(429).json({ error: "Rate limited after multiple retries. Please wait 2 minutes and try again." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
export const config = { maxDuration: 120 };
