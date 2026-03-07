require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Fetch products from Supabase
async function getProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("name, price, original_price, category, brand, in_stock, stock, description")
    .order("name");

  if (error) {
    console.error("Supabase error:", error.message);
    return [];
  }
  return data;
}

// Fetch knowledge entries from Supabase
async function getKnowledge() {
  const { data, error } = await supabase
    .from("knowledge")
    .select("topic, content")
    .eq("is_active", true)
    .order("topic");

  if (error) {
    console.error("Supabase knowledge error:", error.message);
    return [];
  }
  return data;
}

// Build system prompt with live product data and knowledge
async function buildSystemPrompt() {
  const [products, knowledge] = await Promise.all([getProducts(), getKnowledge()]);

  let productList = "No products available.";
  if (products.length > 0) {
    productList = products
      .map((p) => {
        const price = `₱${Number(p.price).toLocaleString()}`;
        const origPrice = p.original_price ? ` (orig: ₱${Number(p.original_price).toLocaleString()})` : "";
        const stock = p.in_stock ? `In stock (${p.stock} pcs)` : "Out of stock";
        const brand = p.brand ? ` | Brand: ${p.brand}` : "";
        return `- ${p.name}${brand} | ${price}${origPrice} | ${stock} | Category: ${p.category}`;
      })
      .join("\n");
  }

  let knowledgeSection = "";
  if (knowledge.length > 0) {
    knowledgeSection = "\n\nSTORE KNOWLEDGE:\n" + knowledge.map((k) => `- ${k.content}`).join("\n");
  }

  return `You are a helpful customer support assistant for RJ MUSIC (rjmusic.shop), a Philippine online store selling musical accessories and studio gear.

Be friendly, concise, and helpful. Answer in the same language the customer uses (simple Bisaya, Filipino, or English)

CURRENT PRODUCTS & STOCK:
${productList}${knowledgeSection}

STORE INFO:
- Website: https://rjmusic.shop
- For orders, direct customers to the website
- For order status inquiries, ask for their order number

GUIDELINES:
- Answer questions about products, availability, prices, and orders
- If a product is out of stock, inform the customer and suggest checking the website for updates
- For complex order issues, advise them to contact support through the website
- Keep replies short and clear`;
}

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);

  res.sendStatus(200); // Respond fast to Facebook

  for (const entry of body.entry) {
    const event = entry.messaging[0];
    if (!event?.message?.text) continue;

    const senderId = event.sender.id;
    const userMessage = event.message.text;

    console.log(`Message from ${senderId}: ${userMessage}`);

    try {
      const systemPrompt = await buildSystemPrompt();
      const reply = await getGPTReply(systemPrompt, userMessage);
      await sendMessage(senderId, reply);
    } catch (err) {
      console.error("Error:", err.message);
    }
  }
});

async function getGPTReply(systemPrompt, userMessage) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_tokens: 500,
  });

  return response.choices[0].message.content;
}

async function sendMessage(recipientId, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text },
    },
    {
      params: { access_token: process.env.PAGE_ACCESS_TOKEN },
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
