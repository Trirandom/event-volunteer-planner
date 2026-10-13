/** @OnlyCurrentDoc */


function appliquerValidationsParColonne() {
  const aSheet = SpreadsheetApp.getActiveSpreadsheet();

  const assignationsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("assignation");

  const schedluesRange = aSheet.getRangeByName("schedulesAssignation")
  const schedluesFirstCol = schedluesRange.getColumn();
  const schedluesLastCol = schedluesRange.getLastColumn();

  const taskRange = aSheet.getRangeByName("tasks")
  const taskFirstRow = taskRange.getRow();
  const taskLastRow = taskRange.getLastRow();

  const dispoSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("somme dispo");
  const volunteersRange = aSheet.getRangeByName("volunteers")
  const volunteersLenght = volunteersRange.getValues().length;

  const sourceDebut = 3;
  const sourceFin = volunteersLenght;


  for (let col = schedluesFirstCol; col <= schedluesLastCol; col++) {
    const plageCible = assignationsSheet.getRange(taskFirstRow, col, taskLastRow - taskFirstRow + 1);
    const plageSource = dispoSheet.getRange(sourceDebut, col, sourceFin - sourceDebut + 1);

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(plageSource, true) // true = menu déroulant + rejet si invalide
      .setAllowInvalid(false)
      .setHelpText("Veuillez choisir un nom depuis la liste ci-dessous ou laisser vide.")
      .build();

    plageCible.setDataValidation(rule);
  }

  SpreadsheetApp.getUi().alert("✅ Validations appliquées à toutes les colonnes d'assignations !");
}