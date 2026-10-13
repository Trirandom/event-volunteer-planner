/** @OnlyCurrentDoc */

function validationParMatrice() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const assignationsSheet = ss.getSheetByName("assignation");
  const matriceSheet = ss.getSheetByName("matrice dispo");
  const dropdownsSheet = ss.getSheetByName("_dropdowns");

  // ─────────────────────────────────────────────
  // ASSIGNATION
  // ─────────────────────────────────────────────

  const targetRange = assignationsSheet.getRange("C5:AE62");

  const targetFirstRow = targetRange.getRow();
  const targetFirstCol = targetRange.getColumn();
  const numRows = targetRange.getNumRows();
  const numCols = targetRange.getNumColumns();

  // Missions affichées dans la colonne A de assignation
  const missionValues = assignationsSheet
    .getRange(targetFirstRow, 1, numRows, 1)
    .getValues()
    .flat();

  // ─────────────────────────────────────────────
  // MATRICE DISPO
  // ─────────────────────────────────────────────

  const matrixFirstRow = 4;
  const matrixFirstCol = 3; // C
  const matrixLastCol = 31; // AE
  const matrixNumCols = matrixLastCol - matrixFirstCol + 1;

  // Noms des missions de la matrice
  const matrixMissions = matriceSheet
    .getRange(matrixFirstRow, 1, 18, 1)
    .getValues()
    .flat()
    .map(value => String(value).trim());

  // Map "nom mission" → index de ligne dans la matrice
  const missionMap = new Map();

  matrixMissions.forEach((mission, index) => {
    if (mission !== "") {
      missionMap.set(mission, index);
    }
  });

  // ─────────────────────────────────────────────
  // GÉNÉRATION DES VALIDATIONS
  // ─────────────────────────────────────────────

  const rules = [];

  let currentMission = "";

  for (let row = 0; row < numRows; row++) {

    // Si A contient une mission, elle devient la mission courante.
    // Sinon on conserve celle de la ligne précédente.
    const missionCell = String(missionValues[row] || "").trim();

    if (missionCell !== "") {
      currentMission = missionCell;
    }

    const rowRules = [];

    // Cherche la ligne correspondante dans matrice dispo
    const matrixRowIndex = missionMap.get(currentMission);

    for (let col = 0; col < numCols; col++) {

      // Pas de mission correspondante
      if (matrixRowIndex === undefined) {
        rowRules.push(null);
        continue;
      }

      // Position de la colonne dans matrice dispo
      const matrixColIndex = col;

      /*
       * _dropdowns est organisé comme ceci :
       *
       * matrice dispo!C4 → _dropdowns!A:A
       * matrice dispo!D4 → _dropdowns!B:B
       * ...
       * matrice dispo!AE4 → _dropdowns!AC:AC
       *
       * matrice dispo!C5 → _dropdowns!AD:AD
       * ...
       */

      const dropdownCol =
        matrixRowIndex * matrixNumCols +
        matrixColIndex +
        1;

      const sourceRange = dropdownsSheet.getRange(
        4,
        dropdownCol,
        100,
        1
      );

      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInRange(sourceRange, true)
        .setAllowInvalid(false)
        .setHelpText(
          "Veuillez choisir un nom depuis la liste ci-dessous ou laisser vide."
        )
        .build();

      rowRules.push(rule);
    }

    rules.push(rowRules);
  }

  // Applique toutes les validations d'un coup
  targetRange.setDataValidations(rules);

  SpreadsheetApp.getUi().alert(
    "✅ Validations appliquées !"
  );
}