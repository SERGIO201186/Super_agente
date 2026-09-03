/**
 * Proxy de la Tutora IA (Agencia Secreta Ortográfica) hacia Gemini.
 *
 * CÓMO DESPLEGARLO (una sola vez):
 * 1. Ve a https://script.google.com/ y crea un proyecto nuevo.
 * 2. Borra el contenido de Code.gs que trae por defecto y pega este archivo completo.
 * 3. Menú "Configuración del proyecto" (ícono de engranaje) > "Propiedades del script"
 *    > "Añadir propiedad del script": nombre GEMINI_API_KEY, valor = tu clave de Gemini
 *    (consíguela gratis en https://aistudio.google.com/apikey). Guarda.
 * 4. Botón "Implementar" > "Nueva implementación" > tipo "Aplicación web".
 *    - Ejecutar como: Yo (tu cuenta)
 *    - Quién tiene acceso: Cualquier usuario
 *    Implementa y copia la URL que termina en /exec.
 * 5. Pega esa URL en index.html, en la constante TUTOR_PROXY_URL.
 *
 * La clave de Gemini NUNCA queda visible en el sitio web: vive solo aquí,
 * dentro de las Propiedades del Script, en tu cuenta de Google.
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
  'Responde en menos de 180 palabras.';

function doPost(e) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) {
      return jsonResponse_({ error: 'El proxy no tiene configurada GEMINI_API_KEY.' });
    }

    var body = {};
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ error: 'Cuerpo de la petición inválido.' });
    }

    var question = (body.question || '').toString().trim().slice(0, MAX_QUESTION_LENGTH);
    if (!question) {
      return jsonResponse_({ error: 'Falta la pregunta.' });
    }

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);

    var payload = {
      contents: [{ role: 'user', parts: [{ text: question }] }],
      systemInstruction: { role: 'system', parts: [{ text: TUTOR_SYSTEM_PROMPT }] },
      generationConfig: { maxOutputTokens: 500, temperature: 0.7 }
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
      return jsonResponse_({ error: apiMessage });
    }

    var candidate = data.candidates && data.candidates[0];
    var parts = candidate && candidate.content && candidate.content.parts;
    var answer = (parts || [])
      .map(function (p) { return p.text || ''; })
      .join('\n')
      .trim();

    if (!answer) {
      return jsonResponse_({ error: 'Gemini no devolvió una respuesta.' });
    }

    return jsonResponse_({ answer: answer });
  } catch (err) {
    return jsonResponse_({ error: 'Error inesperado en el proxy: ' + err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
