// background.js

// Слушатель сетевых запросов
chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Работаем только с запросами из активной вкладки (хотя details.tabId уже это обеспечит)
    // и только если это изображение JPG.
    // details.tabId будет -1, если запрос не связан с вкладкой (например, от другого расширения)
    if (details.type === "image" && details.url.endsWith(".jpg") && details.tabId > 0) {
      console.log(`[Tab ${details.tabId}] Caught JPG:`, details.url);
      const imageInfo = analyzeUrl(details.url);

      if (imageInfo) {
        console.log(`[Tab ${details.tabId}] Analyzed Image Info:`, imageInfo);
        // Сохраняем информацию, привязанную к ID вкладки.
        // Ключ будет выглядеть как 'imageInfoForTab_123'
        const storageKey = `imageInfoForTab_${details.tabId}`;
        chrome.storage.local.set({ [storageKey]: imageInfo }, () => {
          if (chrome.runtime.lastError) {
            console.error(`[Tab ${details.tabId}] Error saving to storage:`, chrome.runtime.lastError);
            return;
          }
          console.log(`[Tab ${details.tabId}] Image info saved to storage with key ${storageKey}.`);
          // Показываем восклицательный знак на иконке расширения для этой вкладки,
          // чтобы пользователь знал, что что-то найдено.
          chrome.action.setBadgeText({ text: "!", tabId: details.tabId });
          chrome.action.setBadgeBackgroundColor({ color: [255, 87, 34, 255], tabId: details.tabId }); // Яркий оранжевый цвет
        });
      }
    }
  },
  { urls: ["<all_urls>"], types: ["image"] }
);

// Обработка сообщений от popup.js (для начала скачивания)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "downloadFullImage") {
    // Убеждаемся, что сообщение пришло от нашего popup
    // sender.tab не будет установлен, если сообщение от самого расширения (например, popup)
    // sender.id это ID расширения
    if (sender.id === chrome.runtime.id && request.imageInfo) {
      console.log("Request to download received:", request.imageInfo);
      startDownloadProcess(request.imageInfo)
        .then(result => {
          sendResponse({ success: true, message: "Загрузка запущена/завершена", ...result });
          // Если скачивание успешно инициировано, можно убрать badge с этой вкладки,
          // но это зависит от того, какой UX вы хотите.
          // Если popup открыт, то пользователь уже знает о статусе.
          // Оставим badge до закрытия вкладки или новой навигации.
        })
        .catch(error => {
          console.error("Download process failed:", error);
          sendResponse({ success: false, message: error.message || "Неизвестная ошибка процесса загрузки." });
        });
      return true; // Для асинхронного sendResponse
    } else {
      sendResponse({ success: false, message: "Некорректный запрос на скачивание."});
    }
  }
});

// Очистка хранилища при закрытии вкладки
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const storageKey = `imageInfoForTab_${tabId}`;
  chrome.storage.local.get(storageKey, (result) => {
    if (result[storageKey]) {
      chrome.storage.local.remove(storageKey, () => {
        if (chrome.runtime.lastError) {
          console.error(`[Tab ${tabId}] Error removing from storage:`, chrome.runtime.lastError);
          return;
        }
        console.log(`[Tab ${tabId}] Cleaned up storage for closed tab.`);
      });
    }
  });
  // Также очищаем badge для этой вкладки, хотя он и так исчезнет с закрытием.
  // Это на случай, если API в будущем изменит поведение.
  chrome.action.setBadgeText({ text: "", tabId: tabId });
});

// Очистка хранилища и badge при навигации на новую страницу в той же вкладке
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Интересует только событие, когда URL изменился и страница начала загружаться.
  // 'loading' гарантирует, что это начало новой навигации.
  // changeInfo.url удостоверяет, что URL действительно изменился (а не просто, например, favicon загрузился).
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const storageKey = `imageInfoForTab_${tabId}`;
    console.log(`[Tab ${tabId}] Navigated to new URL: ${changeInfo.url}. Clearing old data.`);
    chrome.storage.local.get(storageKey, (result) => {
        if (result[storageKey]) {
            chrome.storage.local.remove(storageKey, () => {
                if (chrome.runtime.lastError) {
                    console.error(`[Tab ${tabId}] Error removing from storage on navigation:`, chrome.runtime.lastError);
                } else {
                    console.log(`[Tab ${tabId}] Cleared storage due to navigation.`);
                }
            });
        }
    });
    chrome.action.setBadgeText({ text: "", tabId: tabId });
  }
});


// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (analyzeUrl, startDownloadProcess и т.д.) ---
// Они остаются без изменений, так как их внутренняя логика не зависит от вкладок,
// а только от переданных URL или imageInfo.

// (Ваши функции analyzeUrl, blobToDataURL, startDownloadProcess, checkUrlExists,
// determineMaxScale, determineDimensions, fetchImage, fetchAllTiles, stitchImages
// должны быть здесь без изменений)

// НОВАЯ ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ
async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(blob);
  });
}

async function startDownloadProcess(imageInfo) {
  const { identifier, baseImageUrlPattern, currentScale, originalUrl } = imageInfo;
  const concreteBasePattern = baseImageUrlPattern.replace('{IDENTIFIER}', identifier);

  try {
    console.log("Определение максимального масштаба...");
    const maxScale = await determineMaxScale(concreteBasePattern, currentScale);
    console.log(`Максимальный масштаб определен: ${maxScale}`);

    console.log("Определение размеров для максимального масштаба...");
    const { numRows, numCols, tileWidth, tileHeight } = await determineDimensions(concreteBasePattern, maxScale);
    console.log(`Размеры для масштаба ${maxScale}: ${numRows} строк, ${numCols} столбцов. Тайл: ${tileWidth}x${tileHeight}`);

    if (numRows === 0 || numCols === 0 || tileWidth === 0 || tileHeight === 0) {
      throw new Error("Не удалось определить размеры изображения или тайла. Загрузка прервана.");
    }

    console.log("Загрузка всех тайлов...");
    const tiles = await fetchAllTiles(concreteBasePattern, maxScale, numRows, numCols);
    const fetchedTilesCount = tiles.filter(t => t).length;
    console.log(`Загружено ${fetchedTilesCount} из ${numRows * numCols} тайлов.`);
    if (fetchedTilesCount === 0 && numRows * numCols > 0) {
        throw new Error("Ни один тайл не был успешно загружен. Загрузка прервана.");
    }

    const shouldUseTranspose = originalUrl.includes("dzc_output_files");
    console.log(`Режим склейки (${originalUrl}): ${shouldUseTranspose ? 'транспонированный (dzc_output_files)' : 'стандартный'}`);

    console.log("Склейка изображений...");
    const fullImageBlob = await stitchImages(tiles, numRows, numCols, tileWidth, tileHeight, shouldUseTranspose);
    
    if (!fullImageBlob) {
        console.error("Функция stitchImages вернула null или undefined!");
        throw new Error("Функция stitchImages не смогла вернуть blob. Загрузка прервана.");
    }
    if (!(fullImageBlob instanceof Blob)) {
      console.error("Критично: fullImageBlob НЕ является Blob. Прерывание загрузки.");
      throw new Error("Обработка изображения не привела к созданию валидного Blob объекта.");
    }
    if (fullImageBlob.size === 0) {
        console.warn("Внимание: Созданный blob имеет размер 0. Он может быть пустым или поврежденным.");
    }
    
    console.log("Конвертация blob в Data URL...");
    const dataUrl = await blobToDataURL(fullImageBlob);
    console.log("Data URL создан (длина):", dataUrl ? dataUrl.length : "null");

    if (!dataUrl) {
        throw new Error("Не удалось конвертировать blob в Data URL.");
    }

    chrome.downloads.download({
      url: dataUrl,
      filename: `${identifier}_масштаб${maxScale}_полное.jpg`, // Имя файла на русском
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
          console.error("Ошибка загрузки:", chrome.runtime.lastError.message);
      } else {
          console.log("Загрузка начата с ID:", downloadId);
      }
    });

    return { success: true, maxScale, numRows, numCols };

  } catch (error) {
    console.error("Ошибка в startDownloadProcess:", error.message, error.stack);
    throw error; // Перебрасываем ошибку, чтобы ее поймал вызывающий код
  }
}

async function checkUrlExists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch (e) {
    try {
        const getResponse = await fetch(url);
        if (getResponse.ok) {
            await getResponse.blob();
            return true;
        }
        return false;
    } catch (getError) {
        return false;
    }
  }
}

async function determineMaxScale(basePattern, initialScale) {
  let scale = initialScale;
  for (let i = 0; i < 20; i++) {
    const testUrl = basePattern.replace('{SCALE}', scale + 1).replace('{ROW}', 0).replace('{COL}', 0);
    if (await checkUrlExists(testUrl)) {
      scale++;
    } else {
      break;
    }
  }
  return scale;
}

async function determineDimensions(basePattern, scale) {
  let numRows = 0;
  let numCols = 0;
  let tileWidth = 0;
  let tileHeight = 0;
  let firstTileChecked = false;

  for (let r = 0; r < 2000; r++) {
    const testUrl = basePattern.replace('{SCALE}', scale).replace('{ROW}', r).replace('{COL}', 0);
    if (await checkUrlExists(testUrl)) {
      numRows++;
      if (!firstTileChecked) {
          const img = await fetchImage(testUrl);
          if (img) {
              tileWidth = img.width;
              tileHeight = img.height;
              firstTileChecked = true;
          }
      }
    } else {
      break;
    }
  }

  if (numRows > 0 && firstTileChecked) { // Изменено условие, tileWidth > 0 заменено на firstTileChecked
    for (let c = 0; c < 2000; c++) {
      const testUrl = basePattern.replace('{SCALE}', scale).replace('{ROW}', 0).replace('{COL}', c);
      if (await checkUrlExists(testUrl)) {
        numCols++;
      } else {
        break;
      }
    }
  } else if (numRows > 0 && !firstTileChecked) {
      const testUrlFirst = basePattern.replace('{SCALE}', scale).replace('{ROW}', 0).replace('{COL}', 0);
       const img = await fetchImage(testUrlFirst);
        if (img) {
            tileWidth = img.width;
            tileHeight = img.height;
            firstTileChecked = true; // Устанавливаем флаг
            // Теперь, зная размеры тайла, переопределяем столбцы
            numCols = 0; // Сбрасываем numCols перед пересчетом
            for (let c = 0; c < 2000; c++) {
                const testUrlCol = basePattern.replace('{SCALE}', scale).replace('{ROW}', 0).replace('{COL}', c);
                if (await checkUrlExists(testUrlCol)) {
                    numCols++;
                } else {
                    break;
                }
            }
        } else {
            console.warn("Не удалось загрузить первый тайл (0,0) для определения размеров.");
        }
  }
  return { numRows, numCols, tileWidth, tileHeight };
}

async function fetchImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch (e) {
    console.warn(`Не удалось загрузить или декодировать изображение: ${url}`, e);
    return null;
  }
}

async function fetchAllTiles(basePattern, scale, numRows, numCols) {
  const tiles = [];
  const promises = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const tileUrl = basePattern.replace('{SCALE}', scale).replace('{ROW}', r).replace('{COL}', c);
      promises.push(
          fetchImage(tileUrl).then(img => {
              tiles[r * numCols + c] = img || null; // Сохраняем null если img не загружен
          })
      );
    }
  }
  await Promise.all(promises);
  return tiles;
}

function analyzeUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const tileInfoRegex = /(\d+)\/(\d+)_(\d+)\.jpg$/;
    let scale, row, col, identifier, baseImageUrlPattern;

    for (let i = pathParts.length - 1; i >= 1; i--) {
      const potentialTileInfo = `${pathParts[i-1]}/${pathParts[i]}`;
      const match = potentialTileInfo.match(tileInfoRegex);
      if (match) {
        scale = parseInt(match[1], 10);
        row = parseInt(match[2], 10);
        col = parseInt(match[3], 10);
        let basePathSoFar = pathParts.slice(0, i-1); // Путь до папки с масштабом

        if (url.includes("dzc_output_files")) {
          const dzcIndex = basePathSoFar.lastIndexOf("dzc_output_files");
          if (dzcIndex > 0) { // dzc_output_files не должен быть первым элементом
            identifier = basePathSoFar[dzcIndex - 1];
            const pathUntilIdentifier = basePathSoFar.slice(0, dzcIndex -1).join('/');
            baseImageUrlPattern = `${urlObj.origin}${pathUntilIdentifier}/${identifier}/dzc_output_files/{SCALE}/{ROW}_{COL}.jpg`;
          }
        } else {
          // Предполагаем, что идентификатор - это часть пути перед папкой с масштабом
          // Пример: .../gallery/IMAGE_ID/zoom_level/tile.jpg -> IMAGE_ID это pathParts[i-2]
          // или .../IMAGE_ID/zoom_level/tile.jpg -> IMAGE_ID это pathParts[i-2]
          if (basePathSoFar.length > 0) {
             identifier = basePathSoFar[basePathSoFar.length -1]; // Последний элемент перед папкой масштаба
             const pathUntilIdentifier = basePathSoFar.slice(0, basePathSoFar.length -1).join('/');
             baseImageUrlPattern = `${urlObj.origin}${pathUntilIdentifier}/${identifier}/{SCALE}/{ROW}_{COL}.jpg`;
          }
        }
        if (identifier) {
          return {
            originalUrl: url,
            identifier: identifier,
            currentScale: scale,
            currentRow: row,
            currentCol: col,
            baseImageUrlPattern: baseImageUrlPattern.replace(identifier, '{IDENTIFIER}')
          };
        }
      }
    }
  } catch (e) {
    console.error("Ошибка анализа URL:", url, e);
  }
  return null;
}

async function stitchImages(tiles, numRows, numCols, tileWidth, tileHeight, transpose = false) {
  if (tileWidth === 0 || tileHeight === 0) {
    console.error(`StitchImages (${transpose ? 'транспонированный' : 'стандартный'}): Размеры тайла нулевые.`);
    throw new Error("Размеры тайла неизвестны, склейка невозможна.");
  }

  let finalTotalWidth, finalTotalHeight;
  if (transpose) {
    finalTotalWidth = numRows * tileWidth;
    finalTotalHeight = numCols * tileHeight;
  } else {
    finalTotalWidth = numCols * tileWidth;
    finalTotalHeight = numRows * tileHeight;
  }
  const modeInfoLog = transpose ? 'транспонированный' : 'стандартный';
  console.log(`StitchImages (${modeInfoLog}): Расчетные размеры холста ${finalTotalWidth}x${finalTotalHeight}`);

  if (finalTotalWidth <= 0 || finalTotalHeight <= 0 || finalTotalWidth > 32767 || finalTotalHeight > 32767) {
    throw new Error(`Расчетные размеры холста (${modeInfoLog}: ${finalTotalWidth}x${finalTotalHeight}) некорректны или слишком велики.`);
  }

  const canvas = new OffscreenCanvas(finalTotalWidth, finalTotalHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error(`Не удалось получить 2D контекст для склейки (${modeInfoLog}).`);
  }

  let drawnTiles = 0;
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const tile = tiles[r * numCols + c];
      if (tile instanceof ImageBitmap) {
        try {
          let drawX, drawY;
          if (transpose) {
            drawX = r * tileWidth;
            drawY = c * tileHeight;
          } else {
            drawX = c * tileWidth;
            drawY = r * tileHeight;
          }
          ctx.drawImage(tile, drawX, drawY);
          tile.close();
          drawnTiles++;
        } catch (e) {
          console.warn(`StitchImages (${modeInfoLog}): Ошибка отрисовки тайла ${r},${c}`, e);
        }
      } else if (tile) {
         console.warn(`StitchImages (${modeInfoLog}): Тайл ${r},${c} не является ImageBitmap. Тип: ${typeof tile}`);
      }
    }
  }
  console.log(`StitchImages (${modeInfoLog}): Отрисовано ${drawnTiles} тайлов на холст.`);
  if (drawnTiles === 0 && (numRows * numCols > 0)) {
    console.warn(`StitchImages (${modeInfoLog}): Ни один тайл не был отрисован, изображение может быть пустым.`);
  }

  try {
    const blobResult = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    console.log(`StitchImages (${modeInfoLog}): canvas.convertToBlob успешно, результат:`, blobResult);
    return blobResult;
  } catch (e) {
    console.error(`StitchImages (${modeInfoLog}): Ошибка во время canvas.convertToBlob:`, e);
    throw e;
  }
}


// При установке/обновлении расширения можно очистить старые данные для всех вкладок.
// Однако, это может быть нежелательно, если пользователь ожидает сохранения состояния.
// Для простоты оставим только первоначальную очистку.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // При первой установке можно очистить всё хранилище, если там что-то есть от предыдущих отладок.
    // Это необязательно, но может помочь избежать старых данных.
    // chrome.storage.local.clear(() => console.log("Хранилище очищено при установке."));
    console.log("Расширение установлено.");
  } else if (details.reason === "update") {
    console.log("Расширение обновлено до версии", chrome.runtime.getManifest().version);
    // Здесь можно было бы реализовать миграцию данных, если структура хранения изменилась.
    // Пока просто сообщим об обновлении.
  }
  // Очистка detectImage из старой версии (если ключ был таким)
  chrome.storage.local.remove(["detectedImage"]);
  console.log("Расширение установлено/обновлено. Удален старый ключ 'detectedImage', если существовал.");
});

console.log("Background script (background.js) загружен и активен.");