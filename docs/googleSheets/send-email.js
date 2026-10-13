let dryRun, emailFrom, testEmail, testMode, emailTemplate, emailFromName, emailSubject, sendPdfSchedule, files;

function loadGlobalEmailVariables() {
  aSheet = SpreadsheetApp.getActiveSpreadsheet();
  dryRun = aSheet.getRangeByName('emailDryRun').getValues()[0][0];
  emailFrom = aSheet.getRangeByName('emailLockFrom').getValues()[0][0];
  testEmail = aSheet.getRangeByName('testEmail').getValues()[0][0];
  testMode = aSheet.getRangeByName('emailTestMode').getValues()[0][0];
  emailSubject = aSheet.getRangeByName('emailSubject').getValues()[0][0];
  emailTemplate = aSheet.getRangeByName('emailTemplate').getValues()[0][0];
  emailTemplateNext = aSheet.getRangeByName('emailTemplateNext').getValues()[0][0];
  emailFromName = aSheet.getRangeByName('emailFromName').getValues()[0][0];
  sendPdfSchedule = aSheet.getRangeByName('sendPdfSchedule').getValues()[0][0];
}

function sendEmailToAllVolunteers() {
  const lock = LockService.getScriptLock();

  // Try to acquire the lock immediately
  if (!lock.tryLock(0)) {
    SpreadsheetApp.getUi().alert("The email sending process is already running.");
    return;
  }
  try {
    sendAllEmailsLock()
  } finally {
    lock.releaseLock();
  }
}

// avoid sending email twice
function sendAllEmailsLock() {
  resetLogToSheet();

  loadGlobalEmailVariables();

  if (sendPdfSchedule) {
    files = [exportGlobalPlanningAsPDF()];
  }

  const volunteers = aSheet.getRangeByName("volunteers").getValues();
  const emails = aSheet.getRangeByName("emails").getValues();
  const emailDisabled = aSheet.getRangeByName("isEmailDisabled").getValues()[0]

  let index = 0;

  for (volunteer of volunteers) {
    const name = volunteer[0];
    if (name) {
      if (emailDisabled[index]) {
        logToSheet('disable for ', name)
      } else {
        if (testMode) {
          const precheckSucceed = sendEmail(volunteers[index][0], emails[index][0], index);
          if (precheckSucceed) {
            break;
          }
        } else {
          sendEmail(name, emails[index][0], index);
        }
      }
    }
    index++;
  }
  SpreadsheetApp.getUi().alert("✅ Emails envoyées ! Voir les détails dans les logs.");
}

function sendEmail(name, email, index) {
  if (!email || email.trim().length === 0) {
    logToSheet("Pas d'email pour", name);
    return false;
  }

  const assignationArray = volunteer_summary_object(name)
  let assignation;
  if (assignationArray.length === 0) {
    assignation = [];
  } else {
    assignation = assignationArray?.map(assignInfo => `${assignInfo.day} - ${assignInfo.scheduleStart}-${assignInfo.scheduleEnd} : ${assignInfo.task}`) ?? "";
  }

  const currentRecapSha = sha256(assignation.join("\n"));
  const recapShaRange = aSheet.getRangeByName("emailRecapSha");
  const recapSha = recapShaRange.getValues();
  const previousRecapSha = recapSha[0][index];

  let assignationWording = "<ul>" + assignation.map(assign => {
    return `<li>${assign}</li>`
  }).join('\n') + "</ul>";

  const isFirstEmailSent = previousRecapSha && previousRecapSha.length > 0;
  if (assignation.length === 0) {
    if (isFirstEmailSent) {
      logToSheet(' /!\\ PLUS de créneaux pour', name);
      assignationWording = "Tu n'as plus de créneaux :/ n'hésite pas a revenir vers nous si tu as des questions."
    } else {
      logToSheet('Pas de créneaux pour', name);
      assignationWording = "Désolé, nous n'avons pas pu t'assigner de créneaux :/ n'hésite pas a revenir vers nous si tu as des questions."
    }
  }

  let body = (isFirstEmailSent ? emailTemplateNext : emailTemplate)
    .replace('{{name}}', name)
    .replace('{{assignations}}', assignationWording)


  if (!testMode && previousRecapSha === currentRecapSha) {
    logToSheet('Le récap est identique au dernier email envoyé. Skip', name, '.')
    return false;
  }

  // const icsArray = genAllCalendarInvites(assignationArray);
  // if (icsArray && icsArray.length > 0) {
  //   files = files.concat(icsArray);
  // }
  try {
    if (!dryRun && !testMode) {

      const myEmail = Session.getActiveUser().getEmail();
      if (myEmail !== emailFrom) {
        logToSheet("L'envoie d'email se fait uniquement avec le compte de l'association.");
        throw Error("L'envoie d'email se fait uniquement avec le compte de l'association.");
      }

      MailApp.sendEmail({
        to: email,
        // cc: "",
        // bcc: testEmail,
        subject: emailSubject,
        htmlBody: body,
        name: emailFromName,
        attachments: files
      });
      logToSheet("Envoie de l'email à ", name, " réussie !");
    }
    if (testMode) {
      MailApp.sendEmail({
        to: testEmail,
        subject: emailSubject,
        htmlBody: body,
        name: emailFromName,
        attachments: files
      });
    }
  } catch (error) {
    logToSheet("échec de l'envoie pour ", name, error);
    return;
  }
  if (dryRun) {
    logToSheet("Le script devrait envoyer un email à ", name, assignation[0]);
    logToSheet("email: ", email);
    logToSheet(body);
  } else if (testMode) {
    logToSheet("Un email de test a été envoyé à ", testEmail);
  }

  const emailSentRange = aSheet.getRangeByName("isEmailSent");
  const isEmailSent = emailSentRange.getValues();
  isEmailSent[0][index] = true;
  if (!dryRun && !testMode) {
    emailSentRange.setValues(isEmailSent);
  }

  recapSha[0][index] = currentRecapSha;
  if (!dryRun && !testMode) {
    recapShaRange.setValues(recapSha);
  }
  return true;
}

function genAllCalendarInvites(assignationArray) {
  const icsArray = [];
  for (const elem of assignationArray) {
    const startDate = getDate(elem.day.split(' ')[1]);
    startDate.setHours(Number(elem.scheduleStart.split('h')[0]))
    const endDate = getDate(elem.day.split(' ')[1]);
    const endHour = Number(elem.scheduleEnd.split('h')[0]);
    if (endHour === 0) {
      endDate.setHours(23);
      endDate.setMinutes(59);
    } else {
      endDate.setHours(endHour)
    }
    icsArray.push(genCalendarInvite('Soundclash ' + elem.task, 'Crénaux bénévole Soundclash festival. Mission : ' + elem.task, null, startDate, endDate));
  }
  return icsArray;
}

function getShaFromAssignation(assignation) {
  if (!assignation || assignation === '') {
    return '';
  }
  if (!assignation.join) {
    return sha256(assignation);
  }
  return sha256(assignation.join("\n"));
}

function sha256(input) {
  if (!input) {
    return "";
  }
  const rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input);
  return rawHash.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
