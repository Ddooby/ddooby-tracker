# Ddooby-tracker

## 🚦 CURRENT STATUS

초기 구현 완료. 새 환경에서 아래 순서로 실행:

```bash
cd ddooby-tracker
npm install
npx expo run:android
```

> Android 기기(USB 연결) 또는 에뮬레이터(Android Studio AVD) 필요

GPS 기반 산책 경로 기록 앱 (React Native + Expo)

## 초기 설정

새 환경에서 소스를 받은 후:

```bash
npm install
```

## 앱 실행 (Development Build 필요)

`react-native-maps` 사용으로 Expo Go 미지원. Development Build 필요.

### Android — 로컬 빌드

```bash
npx expo run:android
```

- Android Studio + Android SDK 설치 필요

### Android — 클라우드 빌드 (EAS)

```bash
npm install -g eas-cli
eas login
eas build --profile development --platform android
```

- Expo 계정 필요, 빌드 완료 후 APK 설치

### iOS (Mac 전용)

```bash
npx expo run:ios
```

- Xcode 설치 필요
