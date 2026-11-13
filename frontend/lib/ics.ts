/**
 * A calendar file that repeats on the owner's check-in schedule, so the one
 * thing Vigil asks of them lives where they already look every day.
 */

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Only schedules of at least a day make sense as calendar events. */
export const canRemind = (intervalMs: number) => intervalMs >= 86_400_000;

export function checkInCalendar(opts: { owner: string; url: string; nextDueMs: number; intervalMs: number; graceMs: number }) {
  const days = Math.round(opts.intervalMs / 86_400_000);
  const graceDays = Math.max(1, Math.round(opts.graceMs / 86_400_000));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vigil//Check-in reminders//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:vigil-${opts.owner}@vigil`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(opts.nextDueMs)}`,
    `DURATION:PT15M`,
    `RRULE:FREQ=DAILY;INTERVAL=${days}`,
    "SUMMARY:Check in on your Vigil",
    `DESCRIPTION:Your check-in is due. After that you have ${graceDays} day${graceDays === 1 ? "" : "s"} of grace before your estate settles to your heirs.\\n\\n${opts.url}`,
    `URL:${opts.url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Vigil check-in due tomorrow",
    "TRIGGER:-P1D",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Vigil check-in due now",
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export function download(filename: string, content: string, type = "text/calendar") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
