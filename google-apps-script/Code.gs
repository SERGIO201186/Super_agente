/**
 * Backend compartido de la Agencia Secreta Ortográfica:
 *  - Proxy de la Tutora IA hacia Gemini.
 *  - Registro y reporte de actividad (tiempo de uso, conexiones, misiones)
 *    para el Panel de Padres, guardado en una hoja de Google Sheets.
 *
 * CÓMO DESPLEGARLO (una sola vez):
 * 1. Ve a https://script.google.com/ y crea un proyecto nuevo.
 * 2. Borra el contenido de Code.gs que trae por defecto y pega este archivo completo.
 * 3. Menú "Configuración del proyecto" (ícono de engranaje) > "Propiedades del script"
 *    > "Añadir propiedad del script": nombre GEMINI_API_KEY, valor = tu clave de Gemini
 *    (consíguela gratis en https://aistudio.google.com/apikey).
 *    Agrega otra propiedad: nombre PARENT_PIN, valor = el PIN que quieras usar para
 *    entrar al Panel de Padres (por ejemplo 2709). Guarda.
 * 4. Botón "Implementar" > "Nueva implementación" > tipo "Aplicación web".
 *    - Ejecutar como: Yo (tu cuenta)
 *    - Quién tiene acceso: Cualquier usuario
 *    Implementa y copia la URL que termina en /exec.
 * 5. Pega esa URL en index.html, en la constante TUTOR_PROXY_URL.
 *
 * Al usar por primera vez el registro de actividad, el script crea
 * automáticamente una hoja de cálculo nueva llamada "Reporte de Actividad -
 * Agencia Secreta Ortográfica" en tu Google Drive (no necesitas crearla tú).
 * La primera vez que esto ocurra, Google puede pedirte autorizar permisos
 * adicionales (acceso a Google Sheets) — acéptalos, son necesarios para
 * guardar el reporte.
 *
 * La clave de Gemini NUNCA queda visible en el sitio web: vive solo aquí,
 * dentro de las Propiedades del Script, en tu cuenta de Google.
 *
 * ACTUALIZAR CÓDIGO YA DESPLEGADO: editar Code.gs solo no alcanza. Después
 * de guardar, ve a "Implementar" > "Gestionar implementaciones" > lápiz en
 * la implementación activa > Versión: "Nueva versión" > Implementar, para
 * que la URL /exec ya publicada tome el cambio.
 */

var GEMINI_MODEL = 'gemini-3.6-flash';
var MAX_QUESTION_LENGTH = 500;

var TUTOR_SYSTEM_PROMPT =
  'Eres una tutora escolar paciente, cálida y alentadora para una niña de 10 años ' +
  'que cursa quinto de primaria en México. Ella puede preguntar sobre cualquier ' +
  'materia (matemáticas, ciencias naturales, historia, geografía, etc.), no solo ' +
  'ortografía. Explica el tema de forma muy simple, con un ejemplo concreto y ' +
  'cotidiano, en párrafos cortos, en español de México, con un tono amigable como ' +
  'una agente/detective de una academia secreta. Evita tecnicismos innecesarios. ' +
  'Responde en menos de 180 palabras. Tu respuesta se muestra como texto plano ' +
  'en una app (no hay renderizado de LaTeX ni de Markdown), así que NUNCA uses ' +
  'notación matemática tipo LaTeX (nada de $, \\frac, \\times, ^, _, etc.) ni ' +
  'símbolos de Markdown (nada de **negritas**, # encabezados, etc.). Escribe las ' +
  'fracciones como texto normal, por ejemplo "1/4" o "un cuarto", las operaciones ' +
  'como "3 + 2 = 5", y todo en oraciones simples y claras.';

var ACTIVITY_SHEET_ID_PROP = 'ACTIVITY_SHEET_ID';
var ACTIVITY_SHEET_NAME = 'Actividad';
var PROGRESS_SHEET_NAME = 'Progreso';
var ACTIVITY_TIMEZONE = 'America/Mexico_City';
var ACTIVITY_EVENT_TYPES = ['connect', 'duration', 'mission', 'answer', 'doubt'];
var ACTIVITY_HISTORY_DAYS_BACKEND = 14;

function doPost(e) {
  try {
    var body = {};
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ error: 'Cuerpo de la petición inválido.' });
    }

    var action = body.action || 'ask';
    if (action === 'log') return handleLog_(body);
    if (action === 'report') return handleReport_(body);
    if (action === 'progress') return handleProgress_(body);
    return handleAsk_(body);
  } catch (err) {
    return jsonResponse_({ error: 'Error inesperado en el proxy: ' + err.message });
  }
}

/* =====================================================================
   TUTORA IA (Gemini)
   ===================================================================== */
function handleAsk_(body) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse_({ error: 'El proxy no tiene configurada GEMINI_API_KEY.' });
  }

  var question = (body.question || '').toString().trim().slice(0, MAX_QUESTION_LENGTH);
  if (!question) {
    return jsonResponse_({ error: 'Falta la pregunta.' });
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);

  var payload = {
    contents: [{ role: 'user', parts: [{ text: question }] }],
    systemInstruction: { parts: [{ text: TUTOR_SYSTEM_PROMPT }] },
    generationConfig: {
      // thinkingConfig no es un campo aceptado para este modelo (causaba
      // "Request contains an invalid argument"). En vez de desactivar el
      // razonamiento interno, se le da mucho más margen de tokens para
      // que, aunque "piense" antes de responder, le alcance para llegar
      // a la respuesta real sin cortarse.
      maxOutputTokens: 3000,
      temperature: 0.7
    }
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var status = response.getResponseCode();
  var data = JSON.parse(response.getContentText());

  if (status !== 200) {
    var apiMessage = (data.error && data.error.message) || 'Error al llamar a Gemini.';
    if (data.error && data.error.details) {
      try {
        apiMessage += ' | detalles: ' + JSON.stringify(data.error.details);
      } catch (detailErr) { /* si no se puede serializar, se deja solo el mensaje */ }
    }
    return jsonResponse_({ error: apiMessage });
  }

  var candidate = data.candidates && data.candidates[0];
  var parts = candidate && candidate.content && candidate.content.parts;
  var answer = (parts || [])
    .filter(function (p) { return !p.thought; })
    .map(function (p) { return p.text || ''; })
    .join('\n')
    .trim();

  if (!answer) {
    var reason = candidate && candidate.finishReason;
    return jsonResponse_({ error: 'Gemini no devolvió una respuesta.' + (reason ? ' (finishReason: ' + reason + ')' : '') });
  }

  return jsonResponse_({ answer: answer });
}

/* =====================================================================
   REGISTRO Y REPORTE DE ACTIVIDAD (Panel de Padres)
   ===================================================================== */
function getActivitySheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty(ACTIVITY_SHEET_ID_PROP);
  var ss = null;

  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      ss = null; // el ID guardado ya no es válido; se creará uno nuevo
    }
  }

  if (!ss) {
    ss = SpreadsheetApp.create('Reporte de Actividad - Agencia Secreta Ortográfica');
    props.setProperty(ACTIVITY_SHEET_ID_PROP, ss.getId());
  }

  var sheet = ss.getSheetByName(ACTIVITY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName(ACTIVITY_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Fecha', 'Tipo', 'Dispositivo', 'Mision', 'Puntaje', 'Total', 'Estrellas', 'DuracionSeg', 'Palabra', 'RespuestaCorrecta', 'Seleccionada', 'Acierto', 'Regla']);
  }

  // La columna "Fecha" (B) guarda strings tipo "2026-09-09". Google Sheets
  // detecta ese patrón y auto-convierte la celda a un valor de fecha real,
  // lo que rompe las comparaciones de texto en handleReport_ (fecha === hoy
  // nunca es verdadero, y el orden del historial sale mal porque se agrupa/
  // ordena por Date.toString() en vez de por la fecha). Forzar formato de
  // texto plano en la columna evita que esto vuelva a pasar en filas nuevas.
  sheet.getRange('B:B').setNumberFormat('@');

  return sheet;
}

/**
 * Hoja "Progreso": un resumen de una sola fila (estrellas y misiones
 * acumuladas de por vida, mejor racha) dentro del mismo libro de cálculo.
 * Sirve dos propósitos:
 *  1. Que los papás puedan abrir el libro de Sheets directamente y ver el
 *     avance de Samantha sin depender de la app ni del PIN del Panel de
 *     Padres.
 *  2. Que la app pueda "recuperar" el avance (acción "progress", sin PIN)
 *     si alguna vez se borra el localStorage del teléfono — así el avance
 *     nunca se pierde, porque vive también aquí en la nube.
 * Se mantiene como un contador incremental (no se recalcula escaneando
 * toda la hoja "Actividad" en cada evento) para que siga siendo rápido
 * aunque el historial crezca mucho.
 */
function getProgressSheet_(ss) {
  var sheet = ss.getSheetByName(PROGRESS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PROGRESS_SHEET_NAME);
    sheet.appendRow(['TotalEstrellas', 'TotalMisiones', 'MejorRacha', 'UltimaActualizacion']);
    sheet.getRange('A1:D1').setFontWeight('bold');
    sheet.appendRow([0, 0, 0, '']);
  }
  return sheet;
}

function updateProgressSummary_(ss, starsGained, streakThisMission) {
  var progressSheet = getProgressSheet_(ss);
  var range = progressSheet.getRange(2, 1, 1, 4);
  var row = range.getValues()[0];
  var totalStars = (Number(row[0]) || 0) + starsGained;
  var totalMissions = (Number(row[1]) || 0) + 1;
  var bestStreak = Math.max(Number(row[2]) || 0, streakThisMission);
  range.setValues([[totalStars, totalMissions, bestStreak, new Date().toISOString()]]);
}

function handleLog_(body) {
  var type = (body.type || '').toString();
  if (ACTIVITY_EVENT_TYPES.indexOf(type) === -1) {
    return jsonResponse_({ error: 'Tipo de evento inválido.' });
  }

  var sheet = getActivitySheet_();
  var now = new Date();
  var fecha = Utilities.formatDate(now, ACTIVITY_TIMEZONE, 'yyyy-MM-dd');
  var deviceLabel = (body.deviceLabel || 'Dispositivo').toString().slice(0, 60);
  var missionLabel = (body.missionLabel || '').toString().slice(0, 80);
  var score = Number(body.score) || 0;
  var total = Number(body.total) || 0;
  var stars = Number(body.stars) || 0;
  var durationSec = Number(body.durationSec) || 0;
  // Para 'doubt' se reutilizan las columnas Palabra/RespuestaCorrecta para
  // guardar la pregunta que hizo Samantha y la respuesta de la tutora IA,
  // así que necesitan más espacio que una sola palabra de ortografía.
  var word = (body.word || '').toString().slice(0, type === 'doubt' ? 300 : 60);
  var correctAnswer = (body.correctAnswer || '').toString().slice(0, type === 'doubt' ? 1000 : 60);
  var selected = (body.selected || '').toString().slice(0, 60);
  var correct = type === 'answer' ? (body.correct ? 1 : 0) : '';
  var rule = (body.rule || '').toString().slice(0, 200);

  sheet.appendRow([now.toISOString(), fecha, type, deviceLabel, missionLabel, score, total, stars, durationSec, word, correctAnswer, selected, correct, rule]);

  if (type === 'mission') {
    updateProgressSummary_(sheet.getParent(), stars, Number(body.maxStreak) || 0);
  }

  return jsonResponse_({ ok: true });
}

/**
 * Devuelve el avance acumulado (estrellas, misiones, mejor racha) sin
 * requerir el PIN de los padres: lo necesita la propia app de Samantha
 * para recuperar su avance si el teléfono perdiera el localStorage.
 * No expone nada sensible (ni respuestas, ni horarios, ni errores).
 */
function handleProgress_(body) {
  var sheet = getActivitySheet_();
  var progressSheet = getProgressSheet_(sheet.getParent());
  var row = progressSheet.getRange(2, 1, 1, 4).getValues()[0];
  return jsonResponse_({
    totalStars: Number(row[0]) || 0,
    totalMissions: Number(row[1]) || 0,
    bestStreak: Number(row[2]) || 0
  });
}

function handleReport_(body) {
  var expectedPin = PropertiesService.getScriptProperties().getProperty('PARENT_PIN');
  if (!expectedPin) {
    return jsonResponse_({ error: 'El proxy no tiene configurado PARENT_PIN.' });
  }
  var pin = (body.pin || '').toString().trim();
  if (pin !== expectedPin) {
    return jsonResponse_({ error: 'PIN incorrecto.' });
  }

  var sheet = getActivitySheet_();
  var values = sheet.getDataRange().getValues();
  var todayStr = Utilities.formatDate(new Date(), ACTIVITY_TIMEZONE, 'yyyy-MM-dd');

  var activeSeconds = 0;
  var connections = 0;
  var connectionTimes = [];
  var missionsToday = [];
  var correctToday = 0;
  var incorrectToday = 0;
  var mistakesToday = [];
  var doubtsToday = [];
  var allDoubts = []; // preguntas de otras materias en todo el historial (orden cronológico)
  var totalStarsAllTime = 0;
  var totalMissionsAllTime = 0;
  var totalCorrectAllTime = 0;
  var totalIncorrectAllTime = 0;

  // Acumuladores por día para el historial de días anteriores.
  var byDate = {}; // fecha -> { activeSeconds, connections, missionsCount, correct, incorrect }

  function dayBucket_(fecha) {
    if (!byDate[fecha]) {
      byDate[fecha] = { date: fecha, activeSeconds: 0, connections: 0, missionsCount: 0, correct: 0, incorrect: 0 };
    }
    return byDate[fecha];
  }

  for (var i = 1; i < values.length; i++) { // fila 0 es el encabezado
    var row = values[i];
    var timestamp = row[0];
    var fecha = row[1];
    // Filas antiguas pueden tener la columna Fecha auto-convertida a un
    // valor Date por Google Sheets (ver comentario en getActivitySheet_).
    // Se normaliza de vuelta a texto "yyyy-MM-dd" para que las comparaciones
    // con todayStr y el agrupado/orden del historial funcionen bien.
    if (fecha instanceof Date) {
      fecha = Utilities.formatDate(fecha, ACTIVITY_TIMEZONE, 'yyyy-MM-dd');
    }
    var tipo = row[2];
    var mision = row[4];
    var puntaje = Number(row[5]) || 0;
    var total = Number(row[6]) || 0;
    var estrellas = Number(row[7]) || 0;
    var duracion = Number(row[8]) || 0;
    var palabra = row[9];
    var respuestaCorrecta = row[10];
    var seleccionada = row[11];
    var acierto = row[12];
    var regla = row[13];

    if (tipo === 'mission') {
      totalStarsAllTime += estrellas;
      totalMissionsAllTime += 1;
    }
    if (tipo === 'answer') {
      if (acierto === 1 || acierto === '1') totalCorrectAllTime += 1;
      else totalIncorrectAllTime += 1;
    }
    if (tipo === 'doubt') {
      allDoubts.push({
        date: fecha,
        time: Utilities.formatDate(new Date(timestamp), ACTIVITY_TIMEZONE, 'HH:mm'),
        question: palabra,
        answer: respuestaCorrecta
      });
    }

    if (!fecha) continue;
    var bucket = dayBucket_(fecha);
    if (tipo === 'connect') bucket.connections += 1;
    if (tipo === 'duration') bucket.activeSeconds += duracion;
    if (tipo === 'mission') bucket.missionsCount += 1;
    if (tipo === 'answer') {
      if (acierto === 1 || acierto === '1') bucket.correct += 1;
      else bucket.incorrect += 1;
    }

    if (fecha === todayStr) {
      if (tipo === 'connect') {
        connections += 1;
        connectionTimes.push(Utilities.formatDate(new Date(timestamp), ACTIVITY_TIMEZONE, 'HH:mm'));
      }
      if (tipo === 'duration') activeSeconds += duracion;
      if (tipo === 'mission') {
        missionsToday.push({
          time: Utilities.formatDate(new Date(timestamp), ACTIVITY_TIMEZONE, 'HH:mm'),
          missionLabel: mision,
          score: puntaje,
          total: total,
          stars: estrellas
        });
      }
      if (tipo === 'answer') {
        if (acierto === 1 || acierto === '1') {
          correctToday += 1;
        } else {
          incorrectToday += 1;
          mistakesToday.push({
            time: Utilities.formatDate(new Date(timestamp), ACTIVITY_TIMEZONE, 'HH:mm'),
            word: palabra,
            correctAnswer: respuestaCorrecta,
            selected: seleccionada,
            rule: regla
          });
        }
      }
      if (tipo === 'doubt') {
        doubtsToday.push({
          time: Utilities.formatDate(new Date(timestamp), ACTIVITY_TIMEZONE, 'HH:mm'),
          question: palabra,
          answer: respuestaCorrecta
        });
      }
    }
  }

  var history = Object.keys(byDate)
    .filter(function (fecha) { return fecha !== todayStr; })
    .sort()
    .reverse()
    .slice(0, ACTIVITY_HISTORY_DAYS_BACKEND)
    .map(function (fecha) { return byDate[fecha]; });

  return jsonResponse_({
    today: {
      date: todayStr,
      activeSeconds: activeSeconds,
      connections: connections,
      connectionTimes: connectionTimes,
      missions: missionsToday,
      correct: correctToday,
      incorrect: incorrectToday,
      mistakes: mistakesToday,
      doubts: doubtsToday
    },
    history: history,
    // Últimas dudas de otras materias que Samantha le ha preguntado a la
    // tutora, sin importar el día (no solo hoy), para que los padres vean
    // en qué temas necesita apoyo y puedan reforzarlos o agregar
    // actividades relacionadas.
    recentDoubts: allDoubts.slice(-15).reverse(),
    allTime: {
      totalStars: totalStarsAllTime,
      totalMissions: totalMissionsAllTime,
      totalCorrect: totalCorrectAllTime,
      totalIncorrect: totalIncorrectAllTime
    }
  });
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * SOLO PARA TI: ejecuta esta función UNA VEZ manualmente desde el editor
 * (menú desplegable de funciones junto al botón ▶ Ejecutar, arriba) para
 * autorizar el acceso a Google Sheets ANTES de que el sitio web lo necesite.
 *
 * Una petición externa y anónima (la que hace el sitio) nunca puede mostrar
 * la ventana de permisos de Google; solo tú, ejecutándola aquí dentro del
 * editor con tu propia cuenta, puedes aceptarla. Después de que esto
 * termine sin errores, el sitio web ya podrá usar Sheets normalmente.
 */
function autorizarPermisos() {
  var sheet = getActivitySheet_();
  Logger.log('Autorizado correctamente. Hoja: ' + sheet.getParent().getUrl());
}
