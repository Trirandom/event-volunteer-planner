let testPhoneNumber;
let smsTestMode;
let smsTemplate;
let smsDryRun;
let smsSentCount = 0;

function loadGlobalSmsVariables() {
  aSheet = SpreadsheetApp.getActiveSpreadsheet();
  smsDryRun = aSheet.getRangeByName('smsDryRun').getValues()[0][0];
  testPhoneNumber = aSheet.getRangeByName('testPhoneNumber').getValues()[0][0];
  smsTestMode = aSheet.getRangeByName('smsTestMode').getValues()[0][0];
  smsTemplate = aSheet.getRangeByName('smsTemplate').getValues()[0][0];
  smsTemplateNext = aSheet.getRangeByName('smsTemplateNext').getValues()[0][0];
}

function sendSmsToAllVolunteers() {
  const lock = LockService.getScriptLock();

  // Try to acquire the lock immediately
  if (!lock.tryLock(0)) {
    SpreadsheetApp.getUi().alert("The sms sending process is already running.");
    return;
  }
  try {
    sendSmsToAllVolunteersLock()
  } finally {
    lock.releaseLock();
  }
}

function sendSmsToAllVolunteersLock() {
  resetLogToSheet();

  loadGlobalSmsVariables();
  const volunteers = aSheet.getRangeByName("volunteers").getValues();
  const phoneNumbers = aSheet.getRangeByName("phoneNumbers").getValues();
  const SmsDisabled = aSheet.getRangeByName("isSmsDisabled").getValues()[0]

  let index = 0;

  for (volunteer of volunteers) {
    const name = volunteer[0];
    if (name) {
      if (SmsDisabled[index]) {
        logToSheet('Désactivé pour ', name)
      } else {
        if (smsTestMode) {
          sendSms(name, testPhoneNumber, index);
          SpreadsheetApp.getUi().alert("✅ SMS de test envoyé !");
          return;
        } else {
          sendSms(name, phoneNumbers[index][0], index);
        }
      }
    }
    index++;
  }
  if (dryRun) {
    SpreadsheetApp.getUi().alert("✅ Dry run effectué ! Voir les détails dans les logs.");
  } else {
    SpreadsheetApp.getUi().alert("✅ SMS envoyées ! Voir les détails dans les logs.");
  }
}

function sendSms(name, phoneNumber, index) {
  if (!phoneNumber || phoneNumber.trim().length === 0) {
    logToSheet("Pas de numéro de téléphone pour", name);
    return;
  }
  if (phoneNumber[0] === '0') {
    phoneNumber = phoneNumber.replace(/^0/, '+33');
  }
  if (phoneNumber.length === 9) {
    phoneNumber = '+33' + phoneNumber;
  }

  let assignation = VOLUNTEER_SUMMARY(name);
  assignation = Array.isArray(assignation) ? assignation : [];
  const currentRecapSha = sha256(assignation.join("\n"));
  const recapShaRange = aSheet.getRangeByName("smsRecapSha");
  const recapSha = recapShaRange.getValues();
  const previousRecapSha = recapSha[0][index];

  let assignationWording = assignation.join('\n') ?? "";

  const isfirstSmsSent = previousRecapSha && previousRecapSha.length > 0;
  if (assignation.length === 0) {
    if (isfirstSmsSent) {
      logToSheet(' /!\\ PLUS de créneaux pour', name);
      assignationWording = "Oups, tu n'as plus de créneaux :/ reviens vers nous si tu as des questions."
    } else {
      logToSheet(' /!\\ PAS de créneaux pour', name);
      assignationWording = "Oups, nous n'avons pas pu t'assigner de créneaux :/ reviens vers nous si tu as des questions."
    }
  }


  let smsContent = (isfirstSmsSent ? smsTemplateNext : smsTemplate)
    .replace('{{name}}', name)
    .replace('{{assignations}}', assignationWording)

  if (!smsTestMode && previousRecapSha === currentRecapSha) {
    logToSheet('Le récap est identique au dernier SMS envoyé. Skip', name, '.')
    return;
  }
  let succeed;
  try {
    if (!smsDryRun && !smsTestMode) {
      succeed = sendSMSWithOVH(phoneNumber, smsContent);
      if (succeed) {
        logToSheet("Envoie du SMS à ", name, " réussie !", "(envoie n°", smsSentCount + ")");
      }
    }
    if (smsTestMode) {
      sendSMSWithOVH(testPhoneNumber, smsContent);
      logToSheet("Un Sms de test a été envoyé à ", testPhoneNumber);
    }
  } catch (error) {
    logToSheet("ECHEC de l'envoie de SMS pour ", name, error);
    succeed = false;
    return;
  }
  if (smsDryRun) {
    smsSentCount += 1;
    logToSheet("Le script devrait envoyer un SMS à ", name, phoneNumber, "(envoie n°", smsSentCount + ")");
    logToSheet(smsContent);
    // logToSheet(assignation.join(', '));
  }

  if (succeed) {
    const SmsSentRange = aSheet.getRangeByName("isSmsSent");
    const isSmsSent = SmsSentRange.getValues();
    isSmsSent[0][index] = true;
    if (!smsDryRun && !smsTestMode) {
      SmsSentRange.setValues(isSmsSent);
    }

    recapSha[0][index] = currentRecapSha;
    if (!smsDryRun && !smsTestMode) {
      recapShaRange.setValues(recapSha);
    }
  }
}

function sendSMSWithTwilio(toNumber, messageBody) {
  const accountSid = '__secret__';
  const authToken = '__secret__';
  // to send message with the complete from phone number and avoid the minfy one that you cannot answer to.
  const messagingServiceSid = '__secret__';

  const aSheet = SpreadsheetApp.getActiveSpreadsheet();
  const phoneNumber = aSheet.getRangeByName('phoneNumber').getValues()[0][0];
  const fromNumber = phoneNumber;

  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json';

  const payload = {
    To: toNumber,
    // MessagingServiceSid: messagingServiceSid,
    From: fromNumber,
    Body: messageBody,
  };

  const options = {
    method: 'post',
    payload: payload,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(accountSid + ':' + authToken),
    },
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseData = response.getContentText();

    if (responseData.error) {
      logToSheet(`Erreur d'envoie de SMS ${responseData.toString()}`)
      return false;
    }
    smsSentCount += 1;
    return true;
  } catch (err) {
    logToSheet(`Erreur d'envoie de SMS ${err}`)
    return false;
  }
}

function sendSMSWithOVH(phoneNumber, rawMessage) {

  const applicationKey = '__secret__';
  const applicationSecret = '__secret__';
  const consumerKey = '__secret__';
  const serviceName = '__secret__';
  const sender = '__secret__';

  if (!applicationKey ||
    !applicationSecret ||
    !consumerKey ||
    !serviceName) {
    throw new Error(
      'Missing OVH credentials.'
    );
  }

  // OVH API endpoint
  const url =
    'https://eu.api.ovh.com/1.0/sms/' +
    encodeURIComponent(serviceName) +
    '/jobs';

  const method = 'POST';
  const message = optimizeSmsText(rawMessage)
  // Payload
  const body = {
    charset: 'UTF-8',
    class: 'phoneDisplay',
    coding: '7bit',
    message: message,
    noStopClause: true,
    priority: 'high',
    receivers: [phoneNumber],
    sender: sender,
    senderForResponse: false,
    validityPeriod: 2880
  };

  // IMPORTANT:
  // This exact JSON string must be used both for
  // the signature and for the HTTP request.
  const bodyString = JSON.stringify(body);

  const timestamp = getOvhTimestamp();

  /*
   * OVH signature:
   *
   * $1$SHA1(
   *   ApplicationSecret +
   *   ConsumerKey +
   *   HTTPMethod +
   *   URL +
   *   Body +
   *   Timestamp
   * )
   */
  const stringToSign =
    applicationSecret + '+' +
    consumerKey + '+' +
    method + '+' +
    url + '+' +
    bodyString + '+' +
    timestamp;

  const signature = '$1$' + sha1(stringToSign);

  // Make request
  const response = UrlFetchApp.fetch(url, {
    method: method,
    contentType: 'application/json; charset=utf-8',
    headers: {
      'X-Ovh-Application': applicationKey,
      'X-Ovh-Consumer': consumerKey,
      'X-Ovh-Timestamp': timestamp,
      'X-Ovh-Signature': signature
    },

    payload: bodyString,
  });

  const statusCode = response.getResponseCode();
  const responseBody = response.getContentText();

  Logger.log('OVH HTTP status: ' + statusCode);
  Logger.log('OVH response: ' + responseBody);

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(
      'OVH SMS API error (' +
      statusCode +
      '): ' +
      responseBody
    );
  }

  if (statusCode === 400) {
    logToSheet(`Erreur ${statusCode} d'envoie de SMS ${responseBody.toString()}`)
    return false;
  }

  smsSentCount += 1;
  return true;
}


/**
 * SHA-1 implementation for Google Apps Script.
 *
 * OVH requires SHA-1 for its API signature.
 */
function sha1(input) {

  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    input,
    Utilities.Charset.UTF_8
  );

  return bytes
    .map(function (byte) {
      const value = byte < 0 ? byte + 256 : byte;
      return ('0' + value.toString(16)).slice(-2);
    })
    .join('');
}