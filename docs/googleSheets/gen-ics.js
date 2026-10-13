function genCalendarInvite(title, description, location, startTime, endTime) {
  // Event details
  // var title = "Team Meeting";
  // var description = "Discuss project updates.";
  // var location = "Google Meet";
  // var startTime = new Date("2025-09-10T10:00:00Z"); // UTC
  // var endTime = new Date("2025-09-10T11:00:00Z");   // UTC

  console.log(title, description, location, startTime, endTime);

  // ICS format (iCalendar)
  const ics =
    "BEGIN:VCALENDAR\n" +
    "VERSION:2.0\n" +
    "CALSCALE:GREGORIAN\n" +
    "METHOD:REQUEST\n" +
    "BEGIN:VEVENT\n" +
    "SUMMARY:" + title + "\n" +
    "DTSTART:" + formatDateICS(startTime) + "\n" +
    "DTEND:" + formatDateICS(endTime) + "\n" +
    "LOCATION:" + location + "\n" +
    "DESCRIPTION:" + description + "\n" +
    "UID:" + Utilities.getUuid() + "\n" +
    "STATUS:CONFIRMED\n" +
    "SEQUENCE:0\n" +
    "BEGIN:VALARM\n" +
    "TRIGGER:-PT15M\n" +
    "ACTION:DISPLAY\n" +
    "DESCRIPTION:Reminder\n" +
    "END:VALARM\n" +
    "END:VEVENT\n" +
    "END:VCALENDAR";

  // Send email with .ics attached
  // MailApp.sendEmail({
  //   to: "recipient@example.com",
  //   subject: "Meeting Invite: " + title,
  //   body: "Please find the meeting invite attached.",
  //   attachments: [
  //     Utilities.newBlob(ics, "text/calendar", "invite.ics")
  //   ]
  // });

  return Utilities.newBlob(ics, "text/calendar", "invite.ics");
}

// Helper: format date to ICS standard (UTC)
function formatDateICS(date) {
  return Utilities.formatDate(date, "GMT", "yyyyMMdd'T'HHmmss'Z'");
}