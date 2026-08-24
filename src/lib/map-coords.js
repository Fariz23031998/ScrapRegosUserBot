function decodeText(value) {
  const text = String(value || '');
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

function validCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function parsePair(first, second) {
  return validCoords(Number(first), Number(second));
}

function isYandexMaps(text) {
  return /yandex\.(?:uz|ru|com|by|kz)|maps\.yandex/i.test(text);
}

function isGoogleMaps(text) {
  return /google\.(?:com|ru|uz)|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(text);
}

function parseLonLatPair(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  return validCoords(Number(match[2]), Number(match[1]));
}

function parseLatLonPair(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return null;
  return parsePair(match[1], match[2]);
}

function parseYandexCoords(text) {
  return (
    parseLonLatPair(text, /(?:[?&#/]|,)ll=(-?\d+(?:\.\d+)?)[, ](-?\d+(?:\.\d+)?)/i) ||
    parseLonLatPair(text, /(?:[?&#/])pt=(-?\d+(?:\.\d+)?)[, ](-?\d+(?:\.\d+)?)/i)
  );
}

function parseGoogleCoords(text) {
  return (
    parseLatLonPair(text, /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,\d+(?:\.\d+)?z)?/i) ||
    parseLatLonPair(text, /[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i) ||
    parseLatLonPair(text, /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i)
  );
}

function parseMapCoords(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const text = decodeText(raw);

  if (isYandexMaps(text)) {
    return parseYandexCoords(text) || parseGoogleCoords(text);
  }
  if (isGoogleMaps(text)) {
    return parseGoogleCoords(text) || parseYandexCoords(text);
  }
  return parseGoogleCoords(text) || parseYandexCoords(text);
}

module.exports = {
  parseMapCoords,
};
