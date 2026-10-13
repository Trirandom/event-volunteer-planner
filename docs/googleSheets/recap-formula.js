/** @OnlyCurrentDoc */

function VOLUNTEER_SUMMARY2(name, tasksParams, schedulesParams, daysParams, data) {
  const tasks = tasksParams.map(val => val[0]);
  const schedules = schedulesParams[0];
  const days = daysParams[0];
  Logger.log(tasks, schedules, days, data)
  resultArray = volunteerSummaryLogic(name, tasks, schedules, days, data)
  if (resultArray.length === 0) {
    return ""
  }
  return resultArray?.map(assignInfo => `${assignInfo.day} - ${assignInfo.scheduleStart}-${assignInfo.scheduleEnd} : ${assignInfo.task}`) ?? "";
}

function volunteer_summary_object(name) {
 name = cleanNameToLowerCase(name);
  if (name.length === 0) {
    return "";
  }
  const aSheet = SpreadsheetApp.getActiveSpreadsheet();
  const tasks = aSheet.getRangeByName("tasks").getValues().map(val => val[0]);
  const schedules = aSheet.getRangeByName("schedules").getValues()[0];
  const days = aSheet.getRangeByName("days").getValues()[0];
  const data2 = aSheet.getRangeByName("assignationData").getValues();
  return volunteerSummaryLogic(name, tasks, schedules, days, data2);
}


function VOLUNTEER_SUMMARY(name) {
  // name = "Aurel MARCHAND"

  name = cleanNameToLowerCase(name);
  if (name.length === 0) {
    return "";
  }

  const aSheet = SpreadsheetApp.getActiveSpreadsheet();
  const tasks = aSheet.getRangeByName("tasks").getValues().map(val => val[0]);
  const schedules = aSheet.getRangeByName("schedules").getValues()[0];
  const days = aSheet.getRangeByName("days").getValues()[0];
  const data = aSheet.getRangeByName("assignationData").getValues();

  resultArray = volunteerSummaryLogic(name, tasks, schedules, days, data)
  if (resultArray.length === 0) {
    return ""
  }
  return resultArray?.map(assignInfo => `${assignInfo.day} - ${assignInfo.scheduleStart}-${assignInfo.scheduleEnd} : ${assignInfo.task}`) ?? "";
}

function volunteerSummaryLogic(name, tasks, schedules, days, data) {

  name = cleanNameToLowerCase(name);
  if (name.length === 0) {
    return [];
  }

  let result = [];
  let resultObject = [];

  for (let c = 0; c < data[0].length; c++) {
    for (let r = 0; r < data.length; r++) {
      let currentData = data[r][c];
      if (!currentData) {
        continue;
      }
      currentData = currentData.trim().toLowerCase()
      if (currentData.length === 0) {
        continue;
      }
      if (currentData === name) {
        const assignInfo = {
          task: getTaskName(tasks, r),
          day: formaterDateFr(getDay(days, c)),
          scheduleStart: schedules[c].split('-')[0],
          scheduleEnd: schedules[c].split('-')[1]
        }
        const lastResult = resultObject[resultObject.length - 1]
        if (lastResult && lastResult.day === assignInfo.day && lastResult.scheduleEnd === assignInfo.scheduleStart && lastResult.task === assignInfo.task) {
          result.pop()
          resultObject.pop();
          assignInfo.scheduleStart = lastResult.scheduleStart
        }
        result.push(`${assignInfo.day} - ${assignInfo.scheduleStart}-${assignInfo.scheduleEnd} : ${assignInfo.task}`)
        resultObject.push(assignInfo)
      }
    }
  }

  if (resultObject.length === 0) {
    return [];
  }
  return resultObject; //result;
}

function VOLUNTEER_SUMMARY_BY_DAY(name, targetDay) {
  // name = "Aurel MARCHAND"
  // targetDay = new Date('07-04-2025');
  const aSheet = SpreadsheetApp.getActiveSpreadsheet();

  name = cleanNameToLowerCase(name);
  if (name.length === 0) {
    return "";
  }

  const taskRange = aSheet.getRangeByName("tasks");
  const tasks = taskRange.getValues().map(val => val[0]);
  const data = aSheet.getRangeByName("assignationData").getValues();
  const schedules = aSheet.getRangeByName("schedules").getValues()[0];
  const days = aSheet.getRangeByName("days").getValues()[0];

  let result = [];
  let resultObject = [];

  for (let c = 0; c < data[0].length; c++) {
    for (let r = 0; r < data.length; r++) {
      const currentDay = getDay(days, c);
      let currentData = data[r][c];
      if (!currentData) {
        continue;
      }
      currentData = currentData.trim().toLowerCase()
      if (currentData.length === 0) {
        continue;
      }
      isSameDay = false;
      if (targetDay.getTime && currentDay.getTime) {
        isSameDay = targetDay.getTime() === currentDay.getTime();
      } else {
        isSameDay = targetDay === currentDay;
      }

      if (currentData === name && isSameDay) {
        const assignInfo = {
          task: getTaskName(tasks, r),
          day: formaterDateFr(currentDay),
          scheduleStart: schedules[c].split('-')[0],
          scheduleEnd: schedules[c].split('-')[1]
        }
        const lastResult = resultObject[resultObject.length - 1]
        if (lastResult && lastResult.day === assignInfo.day && lastResult.scheduleEnd === assignInfo.scheduleStart && lastResult.task === assignInfo.task) {
          result.pop()
          assignInfo.scheduleStart = lastResult.scheduleStart
        }
        result.push(`${assignInfo.scheduleStart}-${assignInfo.scheduleEnd} : ${assignInfo.task}`)
        resultObject.push(assignInfo)
      }
    }
  }

  if (result.length === 0) {
    return ""
  }
  return result.join('\n');
}

function getDay(days, colIndex) {
  while (!days[colIndex]) {
    if (colIndex === 0) {
      return ""
    }
    colIndex--
  }
  return days[colIndex];
}

function formaterDateFr(date) {
  const daysFr = {
    "Monday": "Lun.",
    "Tuesday": "Mar.",
    "Wednesday": "Mer.",
    "Thursday": "Jeu.",
    "Friday": "Ven.",
    "Saturday": "Sam.",
    "Sunday": "Dim."
  };

  try {
    const dateStr = Utilities.formatDate(date, "Europe/Paris", "EEEE d/M");
    const [dayEn, datePart] = dateStr.split(" ");
    const dayFr = daysFr[dayEn] || dayEn;
    return `${dayFr} ${datePart}`;
  } catch {
    return date.toString();
  }
}

function getTaskName(tasks, rowIndex) {
  let index = rowIndex;
  while (!tasks[index]) {
    if (index === 0) {
      return ""
    }
    index--
  }
  return tasks[index]
}