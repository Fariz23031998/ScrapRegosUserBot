function buildPublicPricesUrl() {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base) return null;
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/prices`;
}

function registerPricesHandlers(bot) {
  bot.onText(/\/prices(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const url = buildPublicPricesUrl();
    if (!url) {
      await bot.sendMessage(
        chatId,
        'Страница прайса временно недоступна: не настроен PUBLIC_BASE_URL.\nNarxlar sahifasi vaqtincha mavjud emas: PUBLIC_BASE_URL sozlanmagan.'
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      'Прайс услуг / Xizmatlar narxlari\n\nОткройте страницу кнопкой ниже.\nQuyidagi tugma orqali sahifani oching.',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Открыть прайс / Narxlarni ochish',
                url,
              },
            ],
          ],
        },
      }
    );
  });
}

module.exports = {
  buildPublicPricesUrl,
  registerPricesHandlers,
};
