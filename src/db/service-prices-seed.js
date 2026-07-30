const PRICE_COLUMNS = [
  { key: 'fixed', label_ru: 'ФИКСА', label_uz: 'FIKSA' },
  { key: 'min5', label_ru: '5 мин', label_uz: '5 daq' },
  { key: 'min30', label_ru: '30 мин', label_uz: '30 daq' },
  { key: 'hour1', label_ru: '1 час', label_uz: '1 soat' },
  { key: 'hour2', label_ru: '2 часа', label_uz: '2 soat' },
];

function item(nameRu, nameUz, prices = {}) {
  return {
    name_ru: nameRu,
    name_uz: nameUz,
    price_fixed: prices.fixed ?? null,
    price_min5: prices.min5 ?? null,
    price_min30: prices.min30 ?? null,
    price_hour1: prices.hour1 ?? null,
    price_hour2: prices.hour2 ?? null,
  };
}

function category(nameRu, nameUz, items) {
  return { name_ru: nameRu, name_uz: nameUz, items };
}

const DEFAULT_SERVICE_PRICES_CATALOG = {
  title_ru: 'РЕГЛАМЕНТ',
  title_uz: 'REGLAMENT',
  notice_ru:
    'С ДЕЙСТВУЮЩЕЙ ТЕХ ПОДДЕРЖКОЙ ИЛИ ПО НАШЕЙ ВИНЕ ПО ЧАСОВЫЕ УСЛУГИ ПРЕДОСТАВЛЯЮТСЯ БЕСПЛАТНО!',
  notice_uz:
    'AMALDAGI TEXNIK QO‘LLAB-QUVVATLASH BILAN YOKI BIZNING AYBIMIZ BILAN SOATBAY XIZMATLAR BEPUL KO‘RSATILADI!',
  categories: [
    category('STORE MANAGEMENT', 'STORE MANAGEMENT', [
      item('Добавление STORE и настройка', 'STORE qo‘shish va sozlash', {
        fixed: '1440000',
      }),
      item('Вопросы, Проблемы со входом', 'Savollar, kirish muammolari', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Обучение STORE (Предложить ВИДЕО)', 'STORE o‘qitish (VIDEO taklif qilish)', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Перенос SM', 'SM ko‘chirish', { fixed: '100000' }),
      item('Настройка программы, шаблоны и т.п.', 'Dastur sozlash, shablonlar va h.k.', {
        fixed: '70000',
      }),
      item(
        'Помочь разобраться в ошибке (если по нашей вине ОПЛАТУ НЕ БРАТЬ)',
        'Xatoni aniqlashda yordam (bizning aybimiz bilan TO‘LOV OLINMAYDI)',
        {
          min5: '50000',
          min30: '100000',
          hour1: '200000',
          hour2: '300000',
        }
      ),
    ]),
    category('CASH SERVER', 'CASH SERVER', [
      item('Добавление CASH и настройка', 'CASH qo‘shish va sozlash', { fixed: '70000' }),
      item('Вопросы, Проблемы с синхронизацией', 'Savollar, sinxronlash muammolari', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Перенос CASH', 'CASH ko‘chirish', { fixed: '100000' }),
    ]),
    category('POS', 'POS', [
      item('Добавление POS и настройка', 'POS qo‘shish va sozlash', { fixed: '1880000' }),
      item('Вопросы, Проблемы с кассой', 'Savollar, kassa muammolari', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Обучение POS (Предложить ВИДЕО)', 'POS o‘qitish (VIDEO taklif qilish)', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Перенос POS', 'POS ko‘chirish', { fixed: '100000' }),
      item(
        'Настройка программы, шаблоны чека, префиксы и т.п.',
        'Dastur sozlash, chek shablonlari, prefikslar va h.k.',
        { fixed: '70000' }
      ),
    ]),
    category('VCR', 'VCR', [
      item('Добавление/замена перенос и настройка VCR', 'VCR qo‘shish/almashtirish, ko‘chirish va sozlash', {
        fixed: '0',
      }),
      item('Проблемы со входом, Обновление', 'Kirish muammolari, yangilash', { fixed: '0' }),
    ]),
    category('EASYTRADE', 'EASYTRADE', [
      item('Добавление КАССЫ или СКЛАДА и настройка', 'KASSA yoki OMBOR qo‘shish va sozlash', {
        fixed: '1000000',
      }),
      item('Обучение ЕТ (Предложить ВИДЕО)', 'ET o‘qitish (VIDEO taklif qilish)', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Перенос или восстановление ЕТ клиента', 'ET mijozini ko‘chirish yoki tiklash', {
        fixed: '100000',
      }),
      item('Перенос ЕТ сервера', 'ET serverini ko‘chirish', { fixed: '600000' }),
      item('Восстановление ЕТ сервера', 'ET serverini tiklash', { fixed: '800000' }),
      item(
        'Помочь разобраться в ошибке (если по нашей вине ОПЛАТУ НЕ БРАТЬ)',
        'Xatoni aniqlashda yordam (bizning aybimiz bilan TO‘LOV OLINMAYDI)',
        {
          min5: '20000',
          min30: '100000',
          hour1: '200000',
          hour2: '300000',
        }
      ),
    ]),
    category('RPOS', 'RPOS', [
      item('Добавление терминала и настройка', 'Terminal qo‘shish va sozlash', {
        fixed: '1500000',
      }),
      item('Обучение RPOS (Предложить ВИДЕО)', 'RPOS o‘qitish (VIDEO taklif qilish)', {
        min5: '20000',
        min30: '70000',
        hour1: '120000',
        hour2: '160000',
      }),
      item('Перенос или восстановление RPOS клиента', 'RPOS mijozini ko‘chirish yoki tiklash', {
        fixed: '100000',
      }),
      item('Перенос или восстановление RPOS сервера', 'RPOS serverini ko‘chirish yoki tiklash', {
        fixed: '600000',
      }),
      item(
        'Помочь разобраться в ошибке (если по нашей вине ОПЛАТУ НЕ БРАТЬ)',
        'Xatoni aniqlashda yordam (bizning aybimiz bilan TO‘LOV OLINMAYDI)',
        {
          min5: '20000',
          min30: '100000',
          hour1: '200000',
          hour2: '300000',
        }
      ),
    ]),
    category('ОБОРУДОВАНИЕ', 'USKUNALAR', [
      item(
        'Диагностика оборудования (если по нашей вине ОПЛАТУ НЕ БРАТЬ)',
        'Uskuna diagnostikasi (bizning aybimiz bilan TO‘LOV OLINMAYDI)',
        {
          min5: '20000',
          min30: '70000',
          hour1: '120000',
          hour2: '160000',
        }
      ),
      item('Добавление и настройка принтеров (1/3+)', 'Printer qo‘shish va sozlash (1/3+)', {
        fixed: '70 000/120 000',
      }),
      item('Добавление весов/настройка весов', 'Tarozi qo‘shish/sozlash', { fixed: '100000' }),
      item('Установка и настройка PRICECHECKER', 'PRICECHECKER o‘rnatish va sozlash', {
        fixed: '600000',
      }),
      item('Переустановка Windows', 'Windows qayta o‘rnatish', { fixed: '100000' }),
      item(
        'Установка платежных систем и аппаратов на 1 р.м.',
        'To‘lov tizimlari va apparatlarni 1 ish joyiga o‘rnatish',
        { fixed: '150000' }
      ),
      item('Ремонт весов SRAM', 'SRAM tarozisini ta’mirlash', { fixed: '150000' }),
      item('Ремонт весов Клавиатура', 'Tarozi klaviaturasini ta’mirlash', { fixed: '300000' }),
      item('Ремонт весов Градуировка', 'Tarozi graduatsiyasini ta’mirlash', { fixed: '200000' }),
    ]),
  ],
};

module.exports = {
  PRICE_COLUMNS,
  DEFAULT_SERVICE_PRICES_CATALOG,
};
