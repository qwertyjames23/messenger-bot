require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      const reply = await getGPTReply(userMessage);
      await sendMessage(senderId, reply);
    } catch (err) {
      console.error("Error:", err.message);
    }
  }
});

async function getGPTReply(userMessage) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are a helpful assistant on Facebook Messenger. Keep replies concise and friendly.",
      },
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
