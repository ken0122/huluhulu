// Stable, renderer-safe diagnostics. Provider response bodies are never included.
export class CharacterError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const codes = ['CHAR_EMPTY_REPLY','CHAR_JSON','CHAR_TRUNCATED','CHAR_REFUSAL','CHAR_RESPONSE','CHAR_AUTH','CHAR_RATE','CHAR_HTTP','CHAR_NETWORK','CHAR_TIMEOUT','CHAR_UNREADABLE','CHAR_INVALID_OUTPUT','CHAR_INVALID_INPUT','CHAR_INVALID_DRAFT','CHAR_TEXT_EMPTY','CHAR_TEXT_CONTROL','CHAR_TEXT_LONG'];
const rows = {
  'zh-CN': ['角色生成接口返回空正文。','模型未返回完整有效的角色 JSON。','角色生成结果被输出长度上限截断。','模型拒绝了这次角色生成请求。','接口返回结构不兼容，缺少 Messages 正文。','角色生成的 API 凭证不可用。','角色生成请求过多，请稍后重试。','角色生成接口暂时不可用。','无法连接角色生成接口。','角色生成超过 30 秒，请重试。','无法读取角色生成接口的响应。','模型返回的角色字段不完整或无效。','角色生成请求的范围或补充要求无效。','角色草稿无效，请检查输入字段。','{field} 必须是非空文本。','{field} 不能包含换行或控制字符。','{field} 超过 {maximum} 字符（当前 {length}，含空格和标点）。'],
  'zh-TW': ['角色生成介面回傳空白內容。','模型未回傳完整有效的角色 JSON。','角色生成結果被輸出長度上限截斷。','模型拒絕了這次角色生成請求。','介面回傳結構不相容，缺少 Messages 內容。','角色生成的 API 憑證不可用。','角色生成請求過多，請稍後重試。','角色生成介面暫時不可用。','無法連線至角色生成介面。','角色生成超過 30 秒，請重試。','無法讀取角色生成介面的回應。','模型回傳的角色欄位不完整或無效。','角色生成範圍或補充要求無效。','角色草稿無效，請檢查輸入欄位。','{field} 必須是非空文字。','{field} 不能包含換行或控制字元。','{field} 超過 {maximum} 字元（目前 {length}，含空格和標點）。'],
  en: ['The character API returned an empty answer.','The model did not return complete, valid character JSON.','The character result reached the output limit and was cut off.','The model declined this character request.','Incompatible API response: Messages content is missing.','The API credentials for character generation are unavailable.','Too many character requests. Try again shortly.','The character API is temporarily unavailable.','Could not connect to the character API.','Character generation exceeded 30 seconds. Try again.','Could not read the character API response.','The model returned missing or invalid character fields.','Invalid generation scope or extra instructions.','The character draft is invalid. Check the input fields.','{field} must contain text.','{field} cannot contain line breaks or control characters.','{field} exceeds {maximum} characters ({length}, including spaces and punctuation).'],
  ja: ['キャラクターAPIの回答が空です。','完全で有効なキャラクターJSONが返されませんでした。','出力上限に達したため結果が途中で切れました。','モデルが今回の生成を拒否しました。','API応答形式に互換性がありません。Messages本文がありません。','キャラクター生成のAPI認証情報を利用できません。','生成リクエストが多すぎます。少し待って再試行してください。','キャラクターAPIを一時的に利用できません。','キャラクターAPIに接続できません。','生成が30秒を超えました。再試行してください。','キャラクターAPIの応答を読み取れません。','モデルのフィールドが不足しているか無効です。','生成範囲または追加の指示が無効です。','下書きが無効です。入力欄を確認してください。','{field} に文字を入力してください。','{field} に改行や制御文字は使えません。','{field} は{maximum}文字までです（現在{length}、空白・句読点を含む）。'],
  fr: ['La réponse de l’API de personnage est vide.','Le modèle n’a pas renvoyé de JSON de personnage complet et valide.','Le résultat a été coupé à la limite de sortie.','Le modèle a refusé cette demande de personnage.','Réponse API incompatible : contenu Messages absent.','Les identifiants API de génération sont indisponibles.','Trop de demandes. Réessayez dans un instant.','L’API de personnage est temporairement indisponible.','Connexion à l’API de personnage impossible.','La génération a dépassé 30 secondes. Réessayez.','La réponse de l’API est illisible.','Des champs du personnage sont absents ou invalides.','Portée ou consignes de génération invalides.','Brouillon invalide. Vérifiez les champs.','{field} doit contenir du texte.','{field} ne doit pas contenir de sauts de ligne ni de caractères de contrôle.','{field} dépasse {maximum} caractères ({length}, espaces et ponctuation compris).'],
  de: ['Die Charakter-API hat eine leere Antwort geliefert.','Das Modell hat kein vollständiges, gültiges Charakter-JSON geliefert.','Das Ergebnis wurde am Ausgabelimit abgeschnitten.','Das Modell hat diese Charakteranfrage abgelehnt.','Inkompatible API-Antwort: Messages-Inhalt fehlt.','Die API-Zugangsdaten für die Generierung sind nicht verfügbar.','Zu viele Anfragen. Bitte gleich erneut versuchen.','Die Charakter-API ist vorübergehend nicht verfügbar.','Verbindung zur Charakter-API fehlgeschlagen.','Die Generierung hat 30 Sekunden überschritten. Erneut versuchen.','Die API-Antwort konnte nicht gelesen werden.','Charakterfelder fehlen oder sind ungültig.','Ungültiger Generierungsbereich oder Zusatzanweisungen.','Ungültiger Entwurf. Bitte die Felder prüfen.','{field} muss Text enthalten.','{field} darf keine Zeilenumbrüche oder Steuerzeichen enthalten.','{field} überschreitet {maximum} Zeichen ({length}, einschließlich Leerzeichen und Satzzeichen).'],
  ru: ['API персонажа вернул пустой ответ.','Модель не вернула полный корректный JSON персонажа.','Результат обрезан из-за ограничения длины вывода.','Модель отклонила этот запрос персонажа.','Несовместимый ответ API: отсутствует содержимое Messages.','Учётные данные API для генерации недоступны.','Слишком много запросов. Повторите чуть позже.','API персонажа временно недоступен.','Не удалось подключиться к API персонажа.','Генерация превысила 30 секунд. Повторите попытку.','Не удалось прочитать ответ API персонажа.','Поля персонажа отсутствуют или некорректны.','Некорректная область генерации или дополнительные указания.','Некорректный черновик. Проверьте поля.','{field} должно содержать текст.','{field} не должно содержать переносы строк или управляющие символы.','{field} превышает {maximum} символов ({length}, включая пробелы и пунктуацию).'],
};
export const CHARACTER_ERROR_MESSAGES = Object.fromEntries(Object.entries(rows).map(([locale, values]) => [locale, Object.fromEntries(codes.map((code, index) => [code, values[index]]))]));
const stageTimeouts = {
  'zh-CN': ['互动翻译超过 30 秒，请重试。', '格式修正超过 30 秒，请重试。'],
  'zh-TW': ['互動翻譯超過 30 秒，請重試。', '格式修正超過 30 秒，請重試。'],
  en: ['Interaction translation exceeded 30 seconds. Try again.', 'Response repair exceeded 30 seconds. Try again.'],
  ja: ['台詞の翻訳が30秒を超えました。再試行してください。', '回答の修正が30秒を超えました。再試行してください。'],
  fr: ['La traduction a dépassé 30 secondes. Réessayez.', 'La correction a dépassé 30 secondes. Réessayez.'],
  de: ['Die Übersetzung hat 30 Sekunden überschritten. Erneut versuchen.', 'Die Korrektur hat 30 Sekunden überschritten. Erneut versuchen.'],
  ru: ['Перевод превысил 30 секунд. Повторите попытку.', 'Исправление ответа превысило 30 секунд. Повторите попытку.'],
};
for (const [locale, [translation, repair]] of Object.entries(stageTimeouts)) {
  CHARACTER_ERROR_MESSAGES[locale].CHAR_TRANSLATION_TIMEOUT = translation;
  CHARACTER_ERROR_MESSAGES[locale].CHAR_REPAIR_TIMEOUT = repair;
}
const thinkingLimits = {
  'zh-CN': '模型用完输出额度时仍只有思考内容，没有给出台词。请换用可直接回答的对话模型。',
  'zh-TW': '模型用完輸出額度時仍只有思考內容，沒有給出台詞。請改用可直接回答的對話模型。',
  en: 'The model used its output budget on thinking without a final line. Choose a chat model that answers directly.',
  ja: 'モデルは出力上限まで思考し、台詞を返しませんでした。直接回答するチャットモデルを選んでください。',
  fr: 'Le modèle a épuisé sa sortie en réflexion sans réplique finale. Choisissez un modèle qui répond directement.',
  de: 'Das Modell hat sein Ausgabelimit für Überlegungen verbraucht, ohne einen Satz zu liefern. Wählen Sie ein direkt antwortendes Chatmodell.',
  ru: 'Модель исчерпала лимит на размышления, не выдав реплику. Выберите модель, отвечающую напрямую.',
};
const providerSettingsInvalid = {
  'zh-CN': '无法读取已保存的 API 设置。请在聊天设置中清除后重新填写接口、密钥和模型。',
  'zh-TW': '無法讀取已儲存的 API 設定。請在聊天設定中清除後重新填寫介面、金鑰和模型。',
  en: 'The saved API settings cannot be read. Clear Chat Settings, then enter the endpoint, key, and models again.',
  ja: '保存済みのAPI設定を読み取れません。チャット設定を消去し、接続先、キー、モデルを再入力してください。',
  fr: 'Les réglages API enregistrés sont illisibles. Effacez les réglages de chat, puis saisissez à nouveau le point d’accès, la clé et les modèles.',
  de: 'Die gespeicherten API-Einstellungen können nicht gelesen werden. Lösche die Chat-Einstellungen und gib Endpunkt, Schlüssel und Modelle erneut ein.',
  ru: 'Не удалось прочитать сохранённые настройки API. Очистите настройки чата и заново укажите адрес, ключ и модели.',
};
for (const [locale, message] of Object.entries(providerSettingsInvalid)) CHARACTER_ERROR_MESSAGES[locale].CHAR_PROVIDER_SETTINGS = message;
const phaseLabels = {
  'zh-CN': ['台词生成', '台词翻译'], 'zh-TW': ['台詞生成', '台詞翻譯'],
  en: ['Generation', 'Translation'], ja: ['生成', '翻訳'], fr: ['Génération', 'Traduction'],
  de: ['Generierung', 'Übersetzung'], ru: ['Генерация', 'Перевод'],
};
for (const [locale, message] of Object.entries(thinkingLimits)) CHARACTER_ERROR_MESSAGES[locale].CHAR_THINKING_LIMIT = message;
export function characterErrorMessage(locale, error) {
  const message = (CHARACTER_ERROR_MESSAGES[locale] || CHARACTER_ERROR_MESSAGES.en)[error?.code];
  if (!message) return null;
  const details = characterErrorDetails(new CharacterError(error.code, '', error.details));
  const suffix = error.code === 'CHAR_HTTP' && details.status ? ` (HTTP ${details.status})`
    : error.code === 'CHAR_INVALID_OUTPUT' && details.field ? ` (${details.field})` : '';
  const labels = phaseLabels[locale] || phaseLabels.en;
  const phase = ['generation', 'translation'].includes(details.phase) ? `${labels[details.phase === 'translation' ? 1 : 0]}: ` : '';
  const timedMessage = ['CHAR_TIMEOUT', 'CHAR_TRANSLATION_TIMEOUT', 'CHAR_REPAIR_TIMEOUT'].includes(error.code)
    ? message.replace('30', String(details.timeoutSeconds || 30)) : message;
  return phase + timedMessage.replace(/\{(field|maximum|length)\}/g, (_, key) => String(details[key] ?? '?')) + suffix;
}
export function characterErrorDetails(error) {
  if (!(error instanceof CharacterError)) return undefined;
  return Object.fromEntries(Object.entries(error.details || {}).filter(([key, value]) =>
    key === 'field' ? typeof value === 'string' && /^[a-zA-Z0-9.[\]-]{1,100}$/.test(value)
      : key === 'phase' ? ['generation', 'translation'].includes(value)
      : key === 'timeoutSeconds' ? [30, 90].includes(value)
      : key === 'status' ? Number.isInteger(value) && value >= 400 && value <= 599
        : ['maximum', 'length'].includes(key) && Number.isSafeInteger(value) && value >= 0));
}
