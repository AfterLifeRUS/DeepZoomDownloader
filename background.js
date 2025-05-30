
// background.js
// Обработка сетевых запросов и управление загрузкой изображений из активной вкладки

// Константы
const STORAGE_PREFIX = 'imageInfoForTab_'; // Префикс ключа в chrome.storage.local
const BADGE_TEXT = '!';                   // Текст бейджа на иконке расширения
const BADGE_COLOR = [255, 87, 34, 255];    // Цвет бейджа (оранжевый)

// Формирует ключ для хранения данных по идентификатору вкладки
function getStorageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

// Очищает данные и бейдж для указанной вкладки
function clearTabData(tabId) {
  const key = getStorageKey(tabId);
  chrome.storage.local.remove(key, () => {
    if (chrome.runtime.lastError) {
      console.error(`Ошибка при удалении ключа ${key}:`, chrome.runtime.lastError);
    } else {
      console.log(`Данные ${key} удалены из хранилища.`);
    }
  });
  chrome.action.setBadgeText({ text: '', tabId });
}

// Слушатель завершенных сетевых запросов: ловим JPG-изображения из активной вкладки
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.type !== 'image' || !details.url.endsWith('.jpg') || details.tabId <= 0) return;

    console.log(`[Tab ${details.tabId}] Обнаружено изображение JPG:`, details.url);
    const imageInfo = analyzeUrl(details.url);
    if (!imageInfo) return;

    console.log(`[Tab ${details.tabId}] Информация об изображении:`, imageInfo);
    const storageKey = getStorageKey(details.tabId);

    // Сохраняем данные в локальное хранилище
    chrome.storage.local.set({ [storageKey]: imageInfo }, () => {
      if (chrome.runtime.lastError) {
        console.error(`[Tab ${details.tabId}] Ошибка при сохранении:`, chrome.runtime.lastError);
        return;
      }
      console.log(`[Tab ${details.tabId}] Данные сохранены под ключом ${storageKey}.`);
      // Устанавливаем бейдж на иконке расширения
      chrome.action.setBadgeText({ text: BADGE_TEXT, tabId: details.tabId });
      chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId: details.tabId });
    });
  },
  { urls: ['<all_urls>'], types: ['image'] }
);

// Обработка сообщений от popup.js для запуска процесса загрузки
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'downloadFullImage') return;

  // Проверяем источник сообщения и наличие imageInfo
  if (sender.id === chrome.runtime.id && request.imageInfo) {
    console.log('Запуск загрузки для:', request.imageInfo);
    startDownloadProcess(request.imageInfo)
      .then(result => sendResponse({ success: true, message: 'Загрузка запущена', ...result }))
      .catch(error => sendResponse({ success: false, message: error.message }));
    return true; // Указываем на асинхронный sendResponse
  }

  sendResponse({ success: false, message: 'Некорректный запрос на скачивание.' });
});

// Очищаем данные при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabData(tabId);
  console.log(`[Tab ${tabId}] Вкладка закрыта, данные очищены.`);
});

// Очищаем данные и бейдж при навигации на новую страницу в той же вкладке
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    console.log(`[Tab ${tabId}] Навигация на ${changeInfo.url}, очищаем старые данные.`);
    clearTabData(tabId);
  }
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

// Преобразует Blob в Data URL
async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(blob);
  });
}

// Основной процесс загрузки полного изображения
async function startDownloadProcess(imageInfo) {
  const { identifier, baseImageUrlPattern, currentScale, originalUrl, isDeepZoom, infoJsonUrl } = imageInfo;
  console.log('Запрос JSON по URL:', infoJsonUrl);
  const basePattern = baseImageUrlPattern.replace('{IDENTIFIER}', identifier);

  try {
    console.log('Определяем максимальный масштаб...');
    const maxScale = await determineMaxScale(basePattern, currentScale, isDeepZoom, infoJsonUrl);
    console.log(`Максимальный масштаб: ${maxScale}`);

    console.log('Определяем размеры плиток...');
    const { numRows, numCols, tileWidth, tileHeight } = await determineDimensions(basePattern, maxScale, isDeepZoom, infoJsonUrl);
    console.log(`Плиток: ${numRows}x${numCols}, размер тайла: ${tileWidth}x${tileHeight}`);

    if (!numRows || !numCols || !tileWidth || !tileHeight) {
      throw new Error('Некорректные размеры, загрузка прервана.');
    }

    console.log('Загружаем все плитки...');
    const tiles = await fetchAllTiles(basePattern, maxScale, numRows, numCols, isDeepZoom);
    const count = tiles.filter(Boolean).length;
    console.log(`Успешно загружено ${count} из ${numRows * numCols} тайлов.`);
    if (!count) throw new Error('Не загружено ни одной плитки.');

    const transpose = originalUrl.includes('dzc_output_files');
    console.log(`Режим склейки: ${transpose ? 'транспонированный' : 'стандартный'}`);

    console.log('Склеиваем изображение...');
    const blob = await stitchImages(tiles, numRows, numCols, tileWidth, tileHeight, transpose);
    const dataUrl = await blobToDataURL(blob);

    chrome.downloads.download({
      url: dataUrl,
      filename: `${identifier}_масштаб${maxScale}_полное.jpg`,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) console.error('Ошибка загрузки:', chrome.runtime.lastError.message);
      else console.log('Загрузка начата, ID:', downloadId);
    });

    return { success: true, maxScale, numRows, numCols };
  } catch (e) {
    console.error('Ошибка в процессе загрузки:', e);
    throw e;
  }
}

// Проверяет существование URL (HEAD, с fallback на GET)
async function checkUrlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    try {
      const r = await fetch(url);
      return r.ok;
    } catch {
      return false;
    }
  }
}

// Определяет максимальный уровень масштабирования
async function determineMaxScale(basePattern, initialScale, isDeepZoom, infoJsonUrl) {
  if (isDeepZoom && infoJsonUrl) {
    try {
      const response = await fetch(infoJsonUrl);
      const json = await response.json();
      const scaleFactors = json.tiles[0].scaleFactors;
      return Math.max(...scaleFactors);
    } catch (e) {
      console.error('Ошибка при получении JSON:', e);
      throw e;
    }
  } else {
    let scale = initialScale;
    for (let i = 0; i < 20; i++) {
      const test = basePattern.replace('{SCALE}', scale + 1).replace('{ROW}', 0).replace('{COL}', 0);
      if (await checkUrlExists(test)) scale++;
      else break;
    }
    return scale;
  }
}

// Определяет количество строк/столбцов и размер плитки
async function determineDimensions(basePattern, scale, isDeepZoom, infoJsonUrl) {
  if (isDeepZoom && infoJsonUrl) {
    try {
      const response = await fetch(infoJsonUrl);
      const json = await response.json();
      const tileWidth = json.tiles[0].width;
      const tileHeight = json.tiles[0].height;
      const scaleFactors = json.tiles[0].scaleFactors;
      const scaleFactor = scaleFactors.find(sf => sf === scale);
      if (!scaleFactor) throw new Error(`Scale factor ${scale} not found in JSON`);

      const widthAtScale = json.width;
	  //Math.ceil(json.width / scaleFactor);
      const heightAtScale = json.height;
	  //Math.ceil(json.height / scaleFactor);
      const numCols = Math.ceil(widthAtScale / tileWidth);
      const numRows = Math.ceil(heightAtScale / tileHeight);

      return { numRows, numCols, tileWidth, tileHeight };
    } catch (e) {
      console.error('Ошибка при получении JSON:', e);
      throw e;
    }
  } else {
    let numRows = 0, numCols = 0, tileWidth = 0, tileHeight = 0;
    for (let r = 0; r < 2000; r++) {
      const url = basePattern.replace('{SCALE}', scale).replace('{ROW}', r).replace('{COL}', 0);
      if (!(await checkUrlExists(url))) break;
      numRows++;
      if (!tileWidth) {
        const img = await fetchImage(url);
        tileWidth = img?.width || 0;
        tileHeight = img?.height || 0;
      }
    }
    for (let c = 0; c < 2000 && numRows && tileWidth; c++) {
      const url = basePattern.replace('{SCALE}', scale).replace('{ROW}', 0).replace('{COL}', c);
      if (!(await checkUrlExists(url))) break;
      numCols++;
    }
    return { numRows, numCols, tileWidth, tileHeight };
  }
}

// Загружает и декодирует изображение в ImageBitmap
async function fetchImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return createImageBitmap(blob);
  } catch (e) {
    console.warn('Не удалось загрузить изображение:', url, e);
    return null;
  }
}

// Загружает все плитки параллельно
async function fetchAllTiles(basePattern, scale, numRows, numCols, isDeepZoom) {
  const tiles = [];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      let url;
      if (isDeepZoom) {
        url = basePattern.replace('{SCALE}', scale).replace('{COL}', col).replace('{ROW}', row);
      } else {
        url = basePattern.replace('{SCALE}', scale).replace('{ROW}', row).replace('{COL}', col);
      }
      tiles.push(fetchImage(url));
    }
  }
  return Promise.all(tiles.map(p => p.catch(() => null)));
}

// Анализирует URL для извлечения паттерна и метаданных изображения
function analyzeUrl(url) {
  try {
    const u = new URL(url);
    let pathToAnalyze, baseUrl, isDeepZoom = false, infoJsonUrl = null;

    if (u.searchParams.has('DeepZoom')) {
      isDeepZoom = true;
	  const deepZoomPath = u.searchParams.get('DeepZoom');
	  console.log('Определен deepZoomPath:', deepZoomPath);
      const tiffIndex = deepZoomPath.indexOf('.tiff');
	  console.log('Определен tiffIndex:', tiffIndex);
      const basePath = deepZoomPath.substring(0, tiffIndex + 5);
	  console.log('Определен basePath:', basePath);	  
      const jsonPath = basePath + '/info.json';
	  console.log('Определен jsonPath:', jsonPath);		  
	  infoJsonUrl = u.origin + u.pathname + '?IIIF=' + jsonPath;
	  console.log('Определен infoJsonUrl:', infoJsonUrl);		  
      pathToAnalyze = deepZoomPath;
      baseUrl = u.origin + u.pathname + '?DeepZoom=';
    } else {
      pathToAnalyze = u.pathname;
      baseUrl = u.origin;
    }

    const parts = pathToAnalyze.split('/').filter(Boolean);
    const regex = /^(\d+)_(\d+)\.jpg$/;

    for (let i = parts.length - 1; i >= 1; i--) {
      if (/^\d+$/.test(parts[i - 1]) && regex.test(parts[i])) {
        const scale = Number(parts[i - 1]);
        const m = parts[i].match(regex);
        let row = isDeepZoom ? Number(m[2]) : Number(m[1]);
        let col = isDeepZoom ? Number(m[1]) : Number(m[2]);

        let identifier, pathUpToIdentifier;
        const dzcIndex = parts.indexOf('dzc_output_files');
        if (!isDeepZoom && dzcIndex !== -1 && dzcIndex < i - 1) {
          identifier = parts[dzcIndex - 1];
          pathUpToIdentifier = parts.slice(0, dzcIndex - 1).join('/');
        } else {
          identifier = parts[i - 2];
          pathUpToIdentifier = parts.slice(0, i - 2).join('/');
        }

        const hasDzc = !isDeepZoom && dzcIndex !== -1 && dzcIndex < i - 1;
        const tileFormat = isDeepZoom ? '{SCALE}/{COL}_{ROW}.jpg' : '{SCALE}/{ROW}_{COL}.jpg';
        const pattern = `${baseUrl}${pathUpToIdentifier ? '/' + pathUpToIdentifier : ''}/{IDENTIFIER}${hasDzc ? '/dzc_output_files' : ''}/${tileFormat}`;

        return {
          originalUrl: url,
          identifier: identifier,
          currentScale: scale,
          currentRow: row,
          currentCol: col,
          baseImageUrlPattern: pattern,
          isDeepZoom: isDeepZoom,
          infoJsonUrl: infoJsonUrl
        };
      }
    }
  } catch (e) {
    console.error('Ошибка анализа URL:', url, e);
  }
  return null;
}

// Склейка плиток в единое изображение через OffscreenCanvas
async function stitchImages(tiles, numRows, numCols, tileWidth, tileHeight, transpose = false) {
  if (!tileWidth || !tileHeight) throw new Error('Размер плитки неизвестен.');

  const width = transpose ? numRows * tileWidth : numCols * tileWidth;
  const height = transpose ? numCols * tileHeight : numRows * tileHeight;
  if (width <= 0 || height <= 0) throw new Error('Некорректные размеры холста.');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось получить 2D контекст.');

  let count = 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const img = tiles[r * numCols + c];
      if (img instanceof ImageBitmap) {
        const x = transpose ? r * tileWidth : c * tileWidth;
        const y = transpose ? c * tileHeight : r * tileHeight;
        ctx.drawImage(img, x, y);
        img.close();
        count++;
      }
    }
  }
  console.log(`Нарисовано плиток: ${count}`);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

// Очистка хранилища при установке или обновлении расширения
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`Расширение ${details.reason === 'install' ? 'установлено' : 'обновлено'}:`, details);
  chrome.storage.local.remove(['detectedImage']);
});

console.log('background.js загружен.');
