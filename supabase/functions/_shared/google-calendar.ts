// ============================================
// GOOGLE CALENDAR API - Shared Module
// Auth: Google Service Account (JWT)
// Used by: morning-briefing, telegram-bot, trading-agent
// ============================================

// --- Base64URL encoding for JWT ---
function base64url(data: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToBase64url(str: string): string {
  return base64url(new TextEncoder().encode(str));
}

// --- Import RSA key from PEM ---
async function importRSAKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// --- Generate JWT for Google Service Account ---
async function generateGoogleJWT(
  clientEmail: string,
  privateKey: string,
  scopes: string[]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = strToBase64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = strToBase64url(
    JSON.stringify({
      iss: clientEmail,
      scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600, // 1 hour
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = await importRSAKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const sig = base64url(new Uint8Array(signature));
  return `${header}.${payload}.${sig}`;
}

// --- Get OAuth2 Access Token ---
async function getGoogleAccessToken(
  clientEmail: string,
  privateKey: string
): Promise<string | null> {
  try {
    const jwt = await generateGoogleJWT(clientEmail, privateKey, [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    if (!res.ok) {
      console.error("Google OAuth error:", await res.text());
      return null;
    }
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    console.error("getGoogleAccessToken error:", e);
    return null;
  }
}

// --- Calendar Event Interface ---
export interface CalendarEvent {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  colorId?: string; // 1-11 Google Calendar colors
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
}

// Color IDs for Google Calendar:
// 1: Lavender, 2: Sage, 3: Grape, 4: Flamingo, 5: Banana
// 6: Tangerine, 7: Peacock, 8: Graphite, 9: Blueberry, 10: Basil, 11: Tomato
export const GCAL_COLORS = {
  WORK: "8",       // Graphite
  WORKOUT: "10",   // Basil (green)
  TRADING: "11",   // Tomato (red)
  TASK: "9",       // Blueberry
  MISSION: "6",    // Tangerine (orange)
  BRIEFING: "7",   // Peacock (cyan)
  MEAL: "5",       // Banana (yellow)
  GOAL: "3",       // Grape (purple)
};

// --- Google Calendar API Client ---
export class GoogleCalendar {
  private accessToken: string | null = null;
  private calendarId: string;
  private clientEmail: string;
  private privateKey: string;
  private timeZone: string;

  constructor() {
    // Load from environment variables
    const credsJson = Deno.env.get("GOOGLE_CALENDAR_CREDENTIALS") || "";
    this.calendarId = Deno.env.get("GOOGLE_CALENDAR_ID") || "primary";
    this.timeZone = "Asia/Jerusalem"; // Israel Time

    if (credsJson) {
      try {
        const creds = JSON.parse(credsJson);
        this.clientEmail = creds.client_email || "";
        this.privateKey = creds.private_key || "";
      } catch {
        console.error("Invalid GOOGLE_CALENDAR_CREDENTIALS JSON");
        this.clientEmail = "";
        this.privateKey = "";
      }
    } else {
      this.clientEmail = Deno.env.get("GOOGLE_SA_EMAIL") || "";
      this.privateKey = (Deno.env.get("GOOGLE_SA_PRIVATE_KEY") || "").replace(/\\n/g, "\n");
    }
  }

  isConfigured(): boolean {
    return !!(this.clientEmail && this.privateKey);
  }

  private async getToken(): Promise<string | null> {
    if (this.accessToken) return this.accessToken;
    this.accessToken = await getGoogleAccessToken(this.clientEmail, this.privateKey);
    return this.accessToken;
  }

  // --- Create Event ---
  async createEvent(event: CalendarEvent): Promise<string | null> {
    const token = await this.getToken();
    if (!token) return null;
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        }
      );
      if (!res.ok) {
        console.error("createEvent error:", await res.text());
        return null;
      }
      const data = await res.json();
      return data.id || null;
    } catch (e) {
      console.error("createEvent error:", e);
      return null;
    }
  }

  // --- Delete events by summary prefix (cleanup before re-creating) ---
  async clearEvents(dateStr: string, summaryPrefix: string): Promise<number> {
    const token = await this.getToken();
    if (!token) return 0;
    try {
      const timeMin = `${dateStr}T00:00:00+02:00`;
      const timeMax = `${dateStr}T23:59:59+02:00`;
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?` +
          `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=100&singleEvents=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return 0;
      const data = await res.json();
      let deleted = 0;
      for (const ev of data.items || []) {
        if (ev.summary && ev.summary.startsWith(summaryPrefix)) {
          await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events/${ev.id}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
          );
          deleted++;
        }
      }
      return deleted;
    } catch (e) {
      console.error("clearEvents error:", e);
      return 0;
    }
  }

  // --- Bulk create events for a day ---
  async syncDayEvents(dateStr: string, events: CalendarEvent[], prefix: string): Promise<number> {
    // Clear existing auto-generated events for this day
    await this.clearEvents(dateStr, prefix);
    // Create new events
    let created = 0;
    for (const event of events) {
      const id = await this.createEvent(event);
      if (id) created++;
    }
    return created;
  }

  // --- Helper: build event from simple params ---
  buildEvent(
    summary: string,
    date: string, // YYYY-MM-DD
    startTime: string, // HH:MM
    endTime: string, // HH:MM
    description?: string,
    colorId?: string
  ): CalendarEvent {
    return {
      summary,
      description: description || "",
      start: { dateTime: `${date}T${startTime}:00`, timeZone: this.timeZone },
      end: { dateTime: `${date}T${endTime}:00`, timeZone: this.timeZone },
      colorId: colorId || undefined,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
    };
  }

  // --- Create a single mission/task event ---
  async createTaskEvent(
    title: string,
    date: string, // YYYY-MM-DD
    startTime: string, // HH:MM
    durationMinutes: number,
    description?: string,
    colorId?: string
  ): Promise<string | null> {
    const [h, m] = startTime.split(":").map(Number);
    const totalMin = h * 60 + m + durationMinutes;
    const endH = Math.floor(totalMin / 60).toString().padStart(2, "0");
    const endM = (totalMin % 60).toString().padStart(2, "0");
    const endTime = `${endH}:${endM}`;

    const event = this.buildEvent(
      title,
      date,
      startTime,
      endTime,
      description,
      colorId
    );
    return await this.createEvent(event);
  }

  // --- Create trading alert event ---
  async createTradingAlert(
    symbol: string,
    signalType: string, // "LONG" | "SHORT"
    entry: number,
    sl: number,
    tp: number,
    rr: string,
    confidence: number,
    tpSource?: string
  ): Promise<string | null> {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const startH = now.getHours().toString().padStart(2, "0");
    const startM = now.getMinutes().toString().padStart(2, "0");
    const endH = (now.getHours() + 4).toString().padStart(2, "0"); // 4h validity

    const icon = signalType === "LONG" ? "🟢" : "🔴";
    const summary = `${icon} ${signalType} ${symbol} @ $${entry}`;
    const description = [
      `Signal: ${signalType} ${symbol}`,
      `Entry: $${entry}`,
      `SL: $${sl}`,
      `TP: $${tp}${tpSource ? ` (${tpSource})` : ""}`,
      `R:R: ${rr}`,
      `Confiance: ${confidence}%`,
      `Généré: ${now.toLocaleTimeString("fr-FR", { timeZone: "Asia/Jerusalem" })}`,
    ].join("\n");

    const event = this.buildEvent(
      summary,
      dateStr,
      `${startH}:${startM}`,
      `${endH}:${startM}`,
      description,
      GCAL_COLORS.TRADING
    );
    return await this.createEvent(event);
  }
}

// --- Singleton export ---
let _gcalInstance: GoogleCalendar | null = null;
export function getGoogleCalendar(): GoogleCalendar {
  if (!_gcalInstance) _gcalInstance = new GoogleCalendar();
  return _gcalInstance;
}
