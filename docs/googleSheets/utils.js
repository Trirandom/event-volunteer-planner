function cleanNameToLowerCase(name) {
  if (!name) {
    return "";
  }
  name = name.trim().toLowerCase();
  if (name.length === 0) {
    return "";
  }
  return name;
}

function resetLogToSheet() {
  const logCellRange = SpreadsheetApp.getActiveSpreadsheet().getRangeByName('logs')
  const logCell = logCellRange.getValues();
  logCell[0][0] = ""
  logCellRange.setValues(logCell)
}

function logToSheet(...messages) {
  const logCellRange = SpreadsheetApp.getActiveSpreadsheet().getRangeByName('logs')
  const logCell = logCellRange.getValues();
  const combinedMessage = messages.join(' ');

  logCell[0][0] += `\n${combinedMessage}`
  logCellRange.setValues(logCell)
  Logger.log(combinedMessage);
}

function getDate(dayMonthString) {
  var day = parseInt(dayMonthString.split('/')[0], 10);
  var month = parseInt(dayMonthString.split('/')[1], 10) - 1; // months are 0-based in JS
  var year = 2025;
  return new Date(year, month, day);
}

function getOvhTimestamp() {
  const response = UrlFetchApp.fetch(
    'https://eu.api.ovh.com/1.0/auth/time'
  );

  return response.getContentText().trim();
}
