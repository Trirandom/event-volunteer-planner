/** @OnlyCurrentDoc */

function exportGlobalPlanningAsPDF() {
  const spreadsheet = importSpreadsheet();
  const sheet = spreadsheet.getSheetByName('PROD');
  console.log(sheet.getName());
  const sheetId = sheet.getSheetId();

  const url = spreadsheet.getUrl();
  const exportUrl = url.replace(/edit$/, '') +
    'export?format=pdf' +
    '&size=TABLOID' +
    '&portrait=false' + // false = paysage
    // '&fitw=true' + // ajuster à la largeur
    '&sheetnames=false&printtitle=false' +
    '&pagenumbers=false' +
    '&gridlines=false' +
    '&fzr=false' + // gel des volets : false
    '&top_margin=0.4' +
    '&bottom_margin=0.4' +
    '&left_margin=0.1' +
    '&right_margin=0.1' +
    '&gid=' + sheetId;

  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(exportUrl, {
    headers: {
      'Authorization': 'Bearer ' + token
    }
  });

  const blob = response.getBlob().setName('soundclash_planning_benevoles.pdf');

  // Exemple : Enregistrer le PDF dans Google Drive
  //DriveApp.createFile(blob);

  // Ou : Envoyer par email
  // MailApp.sendEmail('adresse@email.com', 'Votre PDF', 'Voici le fichier.', {attachments: [blob]});

  return blob;
}

function importSpreadsheet() {
  // ID of the source spreadsheet
  let sourceId = "__secret__";
  // Open the source spreadsheet
  let sourceSS = SpreadsheetApp.openById(sourceId);
  console.log(sourceSS.getName());
  return sourceSS
}

function getFileFromDrive() {
  // https://drive.google.com/file/d/__secret__/view?usp=sharing
  const fileId = '__secret__'; // récupérable dans l'URL de Google Drive
  const file = DriveApp.getFileById(fileId);
  return file.getAs(MimeType.PDF) // Exemple : fichier PDF
}