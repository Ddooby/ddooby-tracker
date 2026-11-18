import * as TaskManager from 'expo-task-manager';
import { appendActiveSamples, toSample } from '../storage/activeWalk';

export const LOCATION_TASK_NAME = 'ddooby-walk-location';

// 반드시 앱 진입점(index.js) 최상위에서 import 되어야 한다.
// 앱 프로세스가 백그라운드/headless 상태여도 task가 실행되려면 모듈 로드 시점에 등록돼야 한다.
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error, executionInfo }) => {
  if (error) {
    console.warn('[locationTask] error', error.message ?? error);
    return;
  }
  try {
    const locations = data?.locations ?? [];
    if (locations.length === 0) return;
    // eventId를 배치 키에 넣어 같은 첫 timestamp의 배치끼리 덮어쓰지 않게 한다.
    await appendActiveSamples(locations.map(toSample), executionInfo?.eventId);
  } catch (e) {
    console.warn('[locationTask] append failed', e?.message ?? e);
  }
});
