// Ads between games. Off (every: 0) until there is traffic worth it; on our own server set
// ADS_EVERY / ADS_YANDEX / ADS_HOUSE in /etc/mog.env instead (they arrive via /api/config).
//   every:  an ad break after every N-th finished round (0 = never)
//   yandex: Yandex Advertising Network (RSYA) block id, "R-A-1234567-1"
//   house:  your own text to show when there is no network ad (a test, or your own promo)
export const ADS = { every: 0, yandex: '', house: '' };
