// app.json 설정에 Google Maps API 키(환경변수)만 주입한다.
// 키는 프로젝트 루트 .env.local 의 GOOGLE_MAPS_API_KEY 에서 읽는다 (커밋 금지).
module.exports = ({ config }) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.warn(
      'GOOGLE_MAPS_API_KEY 없음 → Android 지도 빈 화면'
    );
  }

  return {
    ...config,
    android: {
      ...config.android,
      config: {
        ...config.android?.config,
        googleMaps: {
          ...config.android?.config?.googleMaps,
          ...(apiKey ? { apiKey } : {}),
        },
      },
    },
  };
};
