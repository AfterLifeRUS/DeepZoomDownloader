// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const identifierEl = document.getElementById('identifier');
  const sourceUrlEl = document.getElementById('sourceUrl');
  const downloadBtn = document.getElementById('downloadBtn');
  const errorEl = document.getElementById('error');
  const statusEl = document.getElementById('status');
  const loaderEl = document.getElementById('loader'); // Элемент загрузчика

  const imageDataContainer = document.getElementById('image-data');
  const noImageContainer = document.getElementById('no-image');

  let currentImageInfo = null;
  let currentTabId = null;

  // Показываем/скрываем элементы
  function showElement(el) {
    el.classList.remove('hidden');
  }
  function hideElement(el) {
    el.classList.add('hidden');
  }

  // 1. Получаем информацию о текущей активной вкладке
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error("Ошибка при запросе вкладок:", chrome.runtime.lastError);
      errorEl.textContent = "Не удалось получить информацию о текущей вкладке.";
      showElement(errorEl);
      hideElement(loaderEl); // Скрыть загрузчик, если он был виден
      return;
    }
    if (tabs && tabs.length > 0) {
      currentTabId = tabs[0].id;
      console.log("Popup открыт на вкладке ID:", currentTabId);

      // Очищаем badge для текущей вкладки, так как пользователь увидел popup
      if (currentTabId) {
        chrome.action.setBadgeText({ text: "", tabId: currentTabId });
      }

      // 2. Загружаем информацию, сохраненную для этой вкладки
      const storageKey = `imageInfoForTab_${currentTabId}`;
      chrome.storage.local.get([storageKey], (result) => {
        if (chrome.runtime.lastError) {
          console.error("Ошибка при чтении из хранилища:", chrome.runtime.lastError);
          errorEl.textContent = "Ошибка загрузки данных изображения.";
          showElement(errorEl);
          showElement(noImageContainer); // Показать сообщение, что нет изображения
          hideElement(imageDataContainer);
          return;
        }

        if (result[storageKey]) {
          currentImageInfo = result[storageKey];
          identifierEl.textContent = currentImageInfo.identifier;
          sourceUrlEl.textContent = currentImageInfo.originalUrl;
          showElement(imageDataContainer);
          hideElement(noImageContainer);
        } else {
          console.log(`Нет сохраненной информации для ключа ${storageKey}`);
          showElement(noImageContainer);
          hideElement(imageDataContainer);
        }
      });
    } else {
      console.error("Не найдено активных вкладок.");
      errorEl.textContent = "Активная вкладка не найдена.";
      showElement(errorEl);
      showElement(noImageContainer);
      hideElement(imageDataContainer);
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (currentImageInfo && currentTabId) {
      statusEl.textContent = 'Обработка... Это может занять некоторое время.';
      showElement(loaderEl); // Показать загрузчик
      downloadBtn.disabled = true;
      hideElement(errorEl); // Скрыть предыдущие ошибки

      chrome.runtime.sendMessage(
        { action: "downloadFullImage", imageInfo: currentImageInfo, tabId: currentTabId /* Передаем tabId для контекста, если нужно */ },
        (response) => {
          hideElement(loaderEl); // Скрыть загрузчик после ответа
          if (chrome.runtime.lastError) {
            console.error("Ошибка при отправке сообщения:", chrome.runtime.lastError);
            errorEl.textContent = `Ошибка: ${chrome.runtime.lastError.message || 'Нет ответа от фонового скрипта.'}`;
            showElement(errorEl);
            statusEl.textContent = 'Ошибка загрузки.';
            downloadBtn.disabled = false;
            return;
          }

          if (response && response.success) {
            statusEl.textContent = `Загрузка инициирована! Макс. масштаб: ${response.maxScale}, ${response.numRows}x${response.numCols} тайлов. Проверьте ваши загрузки.`;
            // Кнопку можно оставить disabled, или скрыть, или сбросить состояние.
            // Для примера, оставим ее активной для повторной попытки, если что-то пошло не так с файлом.
            downloadBtn.disabled = false; // или true, если повторное скачивание не нужно
          } else {
            errorEl.textContent = `Ошибка: ${response ? response.message : 'Неизвестная ошибка во время процесса загрузки.'}`;
            showElement(errorEl);
            statusEl.textContent = 'Ошибка загрузки.';
            downloadBtn.disabled = false;
          }
        }
      );
    } else {
        errorEl.textContent = 'Нет информации об изображении для скачивания.';
        showElement(errorEl);
    }
  });
});