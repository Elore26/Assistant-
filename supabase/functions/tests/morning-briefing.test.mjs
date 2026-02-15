// ============================================
// MORNING BRIEFING — Scraping & Logic Tests (Node.js)
// Tests: Google Maps response parsing, schedule logic,
//        time helpers, plan builder
// ============================================
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// --- Extracted pure functions from morning-briefing/index.ts ---

function toMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}
function fromMin(m) {
  if (m < 0) m += 1440;
  if (m >= 1440) m -= 1440;
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function addMin(time, mins) { return fromMin(toMin(time) + mins); }
function subMin(time, mins) { return fromMin(toMin(time) - mins); }

function getSched(d) {
  const s = {
    0: { type: "long", ws: "09:30", we: "19:30", label: "Journee longue" },
    1: { type: "court", ws: "09:30", we: "15:30", label: "Journee courte" },
    2: { type: "court", ws: "09:30", we: "15:30", label: "Journee courte" },
    3: { type: "court", ws: "09:30", we: "15:30", label: "Journee courte" },
    4: { type: "tardif", ws: "12:00", we: "19:30", label: "Journee tardive" },
    5: { type: "variable", ws: "-", we: "-", label: "Variable" },
    6: { type: "off", ws: "-", we: "-", label: "OFF" },
  };
  return s[d] || s[0];
}

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Google Maps response parsing (from getDriveMin) ---
function parseDriveMinutes(apiResponse) {
  if (apiResponse.status === "OK" && apiResponse.routes?.length > 0 && apiResponse.routes[0].legs?.length > 0) {
    const leg = apiResponse.routes[0].legs[0];
    const seconds = leg.duration_in_traffic?.value || leg.duration?.value || 720;
    return Math.ceil(seconds / 60);
  }
  return 12; // default fallback
}

// --- Train schedule parsing (from getTrainSchedule) ---
function parseTrainSchedule(apiResponse) {
  if (apiResponse.status !== "OK" || !apiResponse.routes?.length) return null;

  const leg = apiResponse.routes[0]?.legs?.[0];
  if (!leg) return null;

  if (leg.steps) {
    for (const step of leg.steps) {
      if (step.travel_mode === "TRANSIT") {
        const td = step.transit_details;
        if (!td) continue;
        return {
          dep: td.departure_time?.text || "",
          arr: td.arrival_time?.text || "",
          dur: step.duration?.text || "",
          line: td.line?.short_name || td.line?.name || "",
          depTs: td.departure_time?.value || 0,
          arrTs: td.arrival_time?.value || 0,
        };
      }
    }
  }

  return {
    dep: leg.departure_time?.text || "",
    arr: leg.arrival_time?.text || "",
    dur: leg.duration?.text || "",
    line: "Israel Railways",
    depTs: leg.departure_time?.value || 0,
    arrTs: leg.arrival_time?.value || 0,
  };
}

function daysUntilDeadline(deadline) {
  const deadlineDate = new Date(deadline);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  deadlineDate.setHours(0, 0, 0, 0);
  const daysMs = deadlineDate.getTime() - today.getTime();
  return Math.ceil(daysMs / (1000 * 60 * 60 * 24));
}

function getDomainEmoji(domain) {
  const emojiMap = {
    career: "💼", finance: "💰", health: "🏋️", higrow: "🚀",
    trading: "📈", learning: "📚", personal: "🏠",
  };
  return emojiMap[domain?.toLowerCase()] || "🎯";
}

// ============================================
// TESTS
// ============================================

describe("Morning Briefing — Google Maps Drive Parsing", () => {
  it("should parse valid drive duration with traffic", () => {
    const mockResponse = {
      status: "OK",
      routes: [{
        legs: [{
          duration: { value: 900, text: "15 min" },
          duration_in_traffic: { value: 1200, text: "20 min" },
        }],
      }],
    };
    const minutes = parseDriveMinutes(mockResponse);
    assert.equal(minutes, 20); // 1200/60 = 20
    console.log("  ✓ Drive duration with traffic parsed: 20 min");
  });

  it("should fallback to duration without traffic", () => {
    const mockResponse = {
      status: "OK",
      routes: [{
        legs: [{
          duration: { value: 720, text: "12 min" },
        }],
      }],
    };
    const minutes = parseDriveMinutes(mockResponse);
    assert.equal(minutes, 12);
    console.log("  ✓ Fallback to non-traffic duration: 12 min");
  });

  it("should return default 12 min on API error", () => {
    assert.equal(parseDriveMinutes({ status: "ZERO_RESULTS" }), 12);
    assert.equal(parseDriveMinutes({ status: "REQUEST_DENIED" }), 12);
    assert.equal(parseDriveMinutes({ status: "OK", routes: [] }), 12);
    console.log("  ✓ Returns default 12 min on error/empty response");
  });

  it("should handle missing legs array", () => {
    const mockResponse = { status: "OK", routes: [{}] };
    const minutes = parseDriveMinutes(mockResponse);
    assert.equal(minutes, 12);
    console.log("  ✓ Handles missing legs gracefully");
  });

  it("should ceil minutes up", () => {
    const mockResponse = {
      status: "OK",
      routes: [{ legs: [{ duration: { value: 650 } }] }], // 650s = 10.83 min
    };
    const minutes = parseDriveMinutes(mockResponse);
    assert.equal(minutes, 11); // ceil(10.83) = 11
    console.log("  ✓ Minutes rounded up correctly");
  });
});

describe("Morning Briefing — Train Schedule Parsing", () => {
  it("should parse train schedule with TRANSIT step", () => {
    const mockResponse = {
      status: "OK",
      routes: [{
        legs: [{
          departure_time: { text: "08:15", value: 1707379200 },
          arrival_time: { text: "09:05", value: 1707382200 },
          duration: { text: "50 min" },
          steps: [{
            travel_mode: "WALKING",
            duration: { text: "5 min" },
          }, {
            travel_mode: "TRANSIT",
            duration: { text: "40 min" },
            transit_details: {
              departure_time: { text: "08:20", value: 1707379500 },
              arrival_time: { text: "09:00", value: 1707381900 },
              line: { short_name: "IL 300", name: "Israel Railways Ashdod-TLV" },
            },
          }, {
            travel_mode: "WALKING",
            duration: { text: "5 min" },
          }],
        }],
      }],
    };

    const train = parseTrainSchedule(mockResponse);
    assert.ok(train, "Should return a train schedule");
    assert.equal(train.dep, "08:20");
    assert.equal(train.arr, "09:00");
    assert.equal(train.line, "IL 300");
    assert.equal(train.depTs, 1707379500);
    console.log("  ✓ Train schedule parsed with TRANSIT step");
  });

  it("should fallback to leg-level timing when no TRANSIT step", () => {
    const mockResponse = {
      status: "OK",
      routes: [{
        legs: [{
          departure_time: { text: "08:15", value: 1707379200 },
          arrival_time: { text: "09:05", value: 1707382200 },
          duration: { text: "50 min" },
          steps: [{ travel_mode: "DRIVING" }],
        }],
      }],
    };

    const train = parseTrainSchedule(mockResponse);
    assert.ok(train);
    assert.equal(train.dep, "08:15");
    assert.equal(train.arr, "09:05");
    assert.equal(train.line, "Israel Railways");
    console.log("  ✓ Fallback to leg-level timing works");
  });

  it("should return null on bad status", () => {
    assert.equal(parseTrainSchedule({ status: "ZERO_RESULTS" }), null);
    assert.equal(parseTrainSchedule({ status: "NOT_FOUND", routes: [] }), null);
    console.log("  ✓ Returns null on bad API status");
  });

  it("should handle missing transit_details gracefully", () => {
    const mockResponse = {
      status: "OK",
      routes: [{
        legs: [{
          departure_time: { text: "08:15", value: 1707379200 },
          arrival_time: { text: "09:05", value: 1707382200 },
          duration: { text: "50 min" },
          steps: [{
            travel_mode: "TRANSIT",
            duration: { text: "40 min" },
            // transit_details is missing!
          }],
        }],
      }],
    };

    const train = parseTrainSchedule(mockResponse);
    // Should fallback to leg-level
    assert.ok(train);
    assert.equal(train.line, "Israel Railways");
    console.log("  ✓ Handles missing transit_details");
  });
});

describe("Morning Briefing — Time Helpers", () => {
  it("should convert time string to minutes", () => {
    assert.equal(toMin("00:00"), 0);
    assert.equal(toMin("06:30"), 390);
    assert.equal(toMin("12:00"), 720);
    assert.equal(toMin("23:59"), 1439);
    console.log("  ✓ toMin() converts correctly");
  });

  it("should convert minutes to time string", () => {
    assert.equal(fromMin(0), "00:00");
    assert.equal(fromMin(390), "06:30");
    assert.equal(fromMin(720), "12:00");
    assert.equal(fromMin(1439), "23:59");
    console.log("  ✓ fromMin() converts correctly");
  });

  it("should handle negative minutes (wraps around)", () => {
    assert.equal(fromMin(-60), "23:00"); // -60 + 1440 = 1380 = 23:00
    assert.equal(fromMin(-1), "23:59");
    console.log("  ✓ Handles negative minutes (midnight wrap)");
  });

  it("should handle overflow minutes", () => {
    assert.equal(fromMin(1440), "00:00"); // midnight
    assert.equal(fromMin(1500), "01:00");
    console.log("  ✓ Handles overflow minutes");
  });

  it("should add minutes to time", () => {
    assert.equal(addMin("08:00", 30), "08:30");
    assert.equal(addMin("23:30", 60), "00:30"); // wraps midnight
    assert.equal(addMin("09:30", 360), "15:30"); // 6 hours
    console.log("  ✓ addMin() works correctly");
  });

  it("should subtract minutes from time", () => {
    assert.equal(subMin("08:30", 30), "08:00");
    assert.equal(subMin("00:30", 60), "23:30"); // wraps midnight
    assert.equal(subMin("09:30", 15), "09:15");
    console.log("  ✓ subMin() works correctly");
  });
});

describe("Morning Briefing — Schedule Logic", () => {
  it("should return correct schedule for each day", () => {
    assert.equal(getSched(0).type, "long");    // Sunday
    assert.equal(getSched(1).type, "court");   // Monday
    assert.equal(getSched(2).type, "court");   // Tuesday
    assert.equal(getSched(3).type, "court");   // Wednesday
    assert.equal(getSched(4).type, "tardif");  // Thursday
    assert.equal(getSched(5).type, "variable"); // Friday
    assert.equal(getSched(6).type, "off");     // Saturday
    console.log("  ✓ Schedule types correct for all days");
  });

  it("should have correct work hours", () => {
    assert.equal(getSched(0).ws, "09:30");
    assert.equal(getSched(0).we, "19:30"); // Long day
    assert.equal(getSched(1).ws, "09:30");
    assert.equal(getSched(1).we, "15:30"); // Short day
    assert.equal(getSched(4).ws, "12:00"); // Late start Thursday
    console.log("  ✓ Work hours correct");
  });
});

describe("Morning Briefing — HTML Escaping", () => {
  it("should escape HTML special characters", () => {
    assert.equal(esc("Hello & World"), "Hello &amp; World");
    assert.equal(esc("<script>alert('xss')</script>"), "&lt;script&gt;alert('xss')&lt;/script&gt;");
    assert.equal(esc("Price > $100"), "Price &gt; $100");
    console.log("  ✓ HTML escaping works correctly");
  });

  it("should handle null/undefined input", () => {
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
    assert.equal(esc(""), "");
    console.log("  ✓ Handles null/undefined input");
  });
});

describe("Morning Briefing — Domain Emoji Mapping", () => {
  it("should return correct emoji for each domain", () => {
    assert.equal(getDomainEmoji("career"), "💼");
    assert.equal(getDomainEmoji("finance"), "💰");
    assert.equal(getDomainEmoji("health"), "🏋️");
    assert.equal(getDomainEmoji("trading"), "📈");
    assert.equal(getDomainEmoji("learning"), "📚");
    console.log("  ✓ Domain emojis mapped correctly");
  });

  it("should return default emoji for unknown domain", () => {
    assert.equal(getDomainEmoji("unknown"), "🎯");
    assert.equal(getDomainEmoji(null), "🎯");
    assert.equal(getDomainEmoji(undefined), "🎯");
    console.log("  ✓ Default emoji for unknown domains");
  });
});

describe("Morning Briefing — Deadline Calculator", () => {
  it("should calculate days until future deadline", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const days = daysUntilDeadline(futureDate.toISOString());
    assert.ok(days >= 29 && days <= 31, `Expected ~30 days, got ${days}`);
    console.log(`  ✓ Future deadline: ${days} days`);
  });

  it("should return 0 for today's deadline", () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const days = daysUntilDeadline(today.toISOString());
    assert.ok(days >= 0 && days <= 1, `Expected 0-1 days, got ${days}`);
    console.log(`  ✓ Today's deadline: ${days} days`);
  });

  it("should return negative for past deadline", () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 5);
    const days = daysUntilDeadline(pastDate.toISOString());
    assert.ok(days <= 0, `Expected negative, got ${days}`);
    console.log(`  ✓ Past deadline: ${days} days`);
  });
});
