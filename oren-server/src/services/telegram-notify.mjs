// ============================================
// TELEGRAM NOTIFY — Send server alerts to Oren
// ============================================

export async function notifyTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });
    if (!res.ok) {
      console.error(`Telegram notify failed: ${res.status}`);
    }
  } catch (e) {
    console.error(`Telegram notify error: ${e.message}`);
  }
}
